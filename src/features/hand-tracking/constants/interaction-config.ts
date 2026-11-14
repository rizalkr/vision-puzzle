export const InteractionConfig = {
  trackingPersistenceMs: 180,
  dragPersistenceMs: 200,
  pinchDebounceMs: 15,
  releaseConfirmationMs: 30,
  
  pinchStartDistance: 0.045,
  pinchEndDistance: 0.065,
  // Palm-size-normalized pinch ratios (aspect-corrected distance(thumb, index) / distance(wrist, middleMCP))
  pinchStartRatio: 0.45,
  pinchInstantRatio: 0.32,
  pinchEndRatio: 0.58,
  
  hoverRadius: 48,
  magneticStrength: 0.75,
  magneticStrengthGrabbed: 0.85,
  
  logicalHitboxScale: 0.98,
  
  adaptiveSmoothing: {
    slow: 0.82,
    fast: 0.45,
  },

  oneEuroFilter: {
    minCutoff: 1.2,
    beta: 8.0,
    dCutoff: 1.0,
    followSpeed: 28,
  },
  
  pointerSize: {
    idle: 24,
    hover: 34,
    grab: 40,
  },
  dragOffsetY: 30,
};
