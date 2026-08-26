import * as THREE from 'three/webgpu'
import { ARC_SEGMENTS, createGreatCircle, EARTH_RADIUS, toEarthVector } from './earthMath'
import type { EarthLocation, EarthSample } from './types'

export type EarthProjection = '3d' | '2d'

export interface EarthView {
  projection: EarthProjection
  // Geography is expressed relative to this longitude, which puts the user in the
  // middle of the flat map. The sphere's seam — and so the map's left and right
  // edges — lands on its antipode, and `globeLayer` cancels the shift out again
  // when it samples the textures.
  centerLongitude: number
}

export const wrapLongitude = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180

// A 2:1 equirectangular plane whose vertical extent matches the sphere's radius,
// so switching projections keeps the subject roughly the same size on screen.
export const PLANE_HALF_WIDTH = 2
export const PLANE_HALF_HEIGHT = 1
// The map imagery carries an extra half-world on each side, so panning and wide
// viewports meet continuing geography instead of a hard edge. Only the imagery is
// extended: arcs, beads and labels stay in the central world.
export const PLANE_EDGE_EXTENSION = PLANE_HALF_WIDTH
// Altitude above the sphere's surface becomes a lift towards the camera, which
// keeps arcs and endpoint beads stacked above the map instead of z-fighting it.
export const PLANE_ALTITUDE_SCALE = 2.5

// How far an arc bows away from its chord, as a fraction of the chord's length.
const PLANE_ARC_BULGE = 0.14
const PLANE_ARC_MAX_BULGE = 0.45
// Just enough to clear the map plane along the whole arc.
const PLANE_ARC_BASE_LIFT = 0.006
const PLANE_ARC_PEAK_LIFT = 0.02

const spherePosition = new THREE.Vector3()
const planePosition = new THREE.Vector3()

// The single source of truth for where a geographic sample lands. `globeLayer`
// mirrors the plane half of this formula in TSL so the mesh and the overlays
// unroll onto exactly the same rectangle.
export const projectEarthSample = (
  sample: EarthSample,
  morph: number,
  target = new THREE.Vector3(),
) => {
  spherePosition.copy(toEarthVector(sample)).multiplyScalar(sample.altitude)

  if (morph <= 0) return target.copy(spherePosition)

  planePosition.set(
    (sample.longitude / 180) * PLANE_HALF_WIDTH,
    (sample.latitude / 90) * PLANE_HALF_HEIGHT,
    (sample.altitude - EARTH_RADIUS) * PLANE_ALTITUDE_SCALE,
  )

  if (morph >= 1) return target.copy(planePosition)

  return target.lerpVectors(spherePosition, planePosition, morph)
}

export const projectionMorph = (projection: EarthProjection) => (projection === '2d' ? 1 : 0)

type ArcEnd = Pick<EarthLocation, 'latitude' | 'longitude'>

// Everything downstream of this works in the view's local frame, so the centring
// is applied exactly once, here.
export const toLocalSample = (
  location: ArcEnd,
  altitude: number,
  view: EarthView,
): EarthSample => ({
  latitude: location.latitude,
  longitude: wrapLongitude(location.longitude - view.centerLongitude),
  altitude,
})

// A great circle is the right path on a globe, but projecting one onto the flat
// map routes China->US over the Pacific, straight off the edge of the projection,
// where it can only be drawn as two disconnected halves. The map therefore lays
// its arcs out directly in map space: the line stays unbroken, at the cost of
// bowing the long way round rather than following the true shortest path.
const createPlaneArc = (from: EarthSample, to: EarthSample) => {
  const start = projectEarthSample(from, 1)
  const end = projectEarthSample(to, 1)
  const chordX = end.x - start.x
  const chordY = end.y - start.y
  const chordLength = Math.hypot(chordX, chordY)
  const bulge = Math.min(PLANE_ARC_MAX_BULGE, chordLength * PLANE_ARC_BULGE)
  // The chord turned by a quarter turn, flipped so every arc bows the same way
  // no matter which direction the route runs.
  const scale = chordLength || 1
  const normalX = -chordY / scale
  const normalY = chordX / scale
  const flip = normalY < 0 ? -1 : 1
  const controlX = (start.x + end.x) / 2 + normalX * flip * bulge
  const controlY = (start.y + end.y) / 2 + normalY * flip * bulge
  const points: THREE.Vector3[] = []

  for (let index = 0; index <= ARC_SEGMENTS; index += 1) {
    const progress = index / ARC_SEGMENTS
    const inverse = 1 - progress
    const startWeight = inverse * inverse
    const controlWeight = 2 * inverse * progress
    const endWeight = progress * progress

    points.push(
      new THREE.Vector3(
        startWeight * start.x + controlWeight * controlX + endWeight * end.x,
        startWeight * start.y + controlWeight * controlY + endWeight * end.y,
        PLANE_ARC_BASE_LIFT + Math.sin(Math.PI * progress) * PLANE_ARC_PEAK_LIFT,
      ),
    )
  }

  return points
}

export const createRouteArc = (from: ArcEnd, to: ArcEnd, view: EarthView) => {
  const localFrom = toLocalSample(from, EARTH_RADIUS, view)
  const localTo = toLocalSample(to, EARTH_RADIUS, view)

  return view.projection === '2d'
    ? createPlaneArc(localFrom, localTo)
    : createGreatCircle(localFrom, localTo)
}

export const easeMorph = (progress: number) => {
  const clamped = THREE.MathUtils.clamp(progress, 0, 1)

  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2
}
