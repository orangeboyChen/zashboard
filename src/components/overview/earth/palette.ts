// Endpoint bead colors, shared by the WebGPU layer and the card legend. Kept in
// a dependency-free module so the legend does not pull `three` into the initial
// bundle, since the renderer itself is imported lazily.
export const ENDPOINT_PALETTE = {
  origin: '#ffffff',
  destination: '#79d8ff',
  direct: '#ff9f43',
} as const
