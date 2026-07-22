/**
 * Direction presets for chest-mounted 360 (equirect, typically after MediaSDK
 * FlowState + Direction Lock). Angles are ffmpeg v360 degrees.
 *
 * Tune with --yaw/--pitch/--fov overrides or a custom presets JSON.
 */
export const DEFAULT_PRESETS = {
  // Running direction / trail ahead (Direction-Lock “front”)
  forward: { yaw: 0, pitch: -8, roll: 0, h_fov: 90, v_fov: 70, label: 'forward (trail)' },
  // Chest harness → look back+up at wearer’s face (NOT yaw=0 / zenith)
  selfie: { yaw: 180, pitch: 35, roll: 0, h_fov: 85, v_fov: 65, label: 'selfie (look back+up at wearer)' },
  // Straight up (sky / overhead action)
  up: { yaw: 0, pitch: 55, roll: 0, h_fov: 85, v_fov: 65, label: 'up (zenith)' },
  // Side glances
  left: { yaw: -90, pitch: -5, roll: 0, h_fov: 90, v_fov: 70, label: 'left' },
  right: { yaw: 90, pitch: -5, roll: 0, h_fov: 90, v_fov: 70, label: 'right' },
  // Glance behind along path / group behind (horizon)
  back: { yaw: 180, pitch: -5, roll: 0, h_fov: 90, v_fov: 70, label: 'back (horizon)' },
};

export function resolvePreset(name, presets = DEFAULT_PRESETS) {
  const key = String(name || '').toLowerCase();
  if (!presets[key]) {
    throw new Error(`Unknown preset "${name}". Available: ${Object.keys(presets).join(', ')}`);
  }
  return { name: key, ...presets[key] };
}

/** Build ffmpeg v360 filter for one flat view from equirect. */
export function v360Filter(view, { width = 1280, height = 720 } = {}) {
  const { yaw, pitch, roll, h_fov, v_fov } = view;
  return [
    `v360=input=e:output=flat`,
    `yaw=${yaw}`,
    `pitch=${pitch}`,
    `roll=${roll}`,
    `h_fov=${h_fov}`,
    `v_fov=${v_fov}`,
    `w=${width}`,
    `h=${height}`,
  ].join(':');
}
