/**
 * GLSL for the fleet hologram.
 *
 * The rebuild effect: when the selected vehicle changes, a horizontal scan
 * plane (`uScan`, world-space y) rises through the projector volume. Below it
 * the new vehicle exists, above it the old one — particles take off as the
 * plane approaches their destination and land as it passes, while line art is
 * cut along the same plane with a glowing seam. One number drives everything,
 * so the swarm and the wireframes always stay in register.
 */

const NOISE = /* glsl */ `
  float fleetHash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  float fleetHash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float fleetNoise1(float x) {
    float i = floor(x);
    float f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(fleetHash11(i), fleetHash11(i + 1.0), f);
  }

  float fleetNoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(fleetHash13(i), fleetHash13(i + vec3(1, 0, 0)), f.x),
          mix(fleetHash13(i + vec3(0, 1, 0)), fleetHash13(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(fleetHash13(i + vec3(0, 0, 1)), fleetHash13(i + vec3(1, 0, 1)), f.x),
          mix(fleetHash13(i + vec3(0, 1, 1)), fleetHash13(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }

  // A bright band that climbs the hologram every few seconds (idle "rescan").
  float fleetSweep(float y, float time) {
    float h = mod(time * 0.42, 6.0) - 2.4;
    return smoothstep(0.16, 0.0, abs(y - h)) * 0.9;
  }

  // 1 when a view-space point sits behind ZENITH's event horizon (seen from
  // the camera, inside the shadow disc and further away than its centre).
  float fleetBehindHorizon(vec3 v, vec4 hole) {
    if (hole.w <= 0.0) return 0.0;
    vec2 onPlane = v.xy * (hole.z / min(v.z, -0.001));
    float inside = 1.0 - smoothstep(hole.w * 0.94, hole.w * 1.04, length(onPlane - hole.xy));
    return inside * step(v.z, hole.z);
  }

  // Classified interference: slow horizontal bands that swallow the structure.
  float fleetInterference(float y, float time) {
    float n = fleetNoise1(y * 2.7 + time * 0.32) * 0.65 + fleetNoise1(y * 9.0 - time * 0.5) * 0.35;
    return smoothstep(0.56, 0.68, n);
  }
`

/* --------------------------------------------------------------------------
 * Swarm (points)
 * ------------------------------------------------------------------------ */
export const swarmVertex = /* glsl */ `
  uniform float uTime;
  uniform float uClock;
  uniform float uFrom;
  uniform float uTo;
  uniform float uScan;
  uniform float uSize;
  uniform float uMinSize;
  uniform float uPadY;
  uniform float uOpacity;
  uniform vec3 uColor[4];
  uniform vec3 uHot[4];
  uniform float uGain[4];
  uniform vec4 uHole;     // ZENITH horizon: view-space centre (xyz) + radius (w)

  // Per vehicle: xyz + size, and spin axis + angular speed.
  attribute vec4 aP0;
  attribute vec4 aP1;
  attribute vec4 aP2;
  attribute vec4 aP3;
  attribute vec4 aS0;
  attribute vec4 aS1;
  attribute vec4 aS2;
  attribute vec4 aS3;
  // x: launch lead, y: twinkle rate, z: brightness, w: phase
  attribute vec4 aRand;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vWorldY;
  varying float vHeat;

  ${NOISE}

  vec3 spinAbout(vec3 p, vec4 s, float t) {
    float a = s.w * t;
    float c = cos(a);
    float si = sin(a);
    return p * c + cross(s.xyz, p) * si + s.xyz * dot(s.xyz, p) * (1.0 - c);
  }

  vec4 shapeP(float i) {
    if (i < 0.5) return aP0;
    if (i < 1.5) return aP1;
    if (i < 2.5) return aP2;
    return aP3;
  }

  vec4 shapeS(float i) {
    if (i < 0.5) return aS0;
    if (i < 1.5) return aS1;
    if (i < 2.5) return aS2;
    return aS3;
  }

  // Index -1: idle dust resting on the projector pad.
  vec3 shapePos(float i) {
    if (i < -0.5) {
      float a = aRand.w * 6.2831853 + uClock * 0.05;
      float r = 0.2 + sqrt(aRand.z) * 1.5;
      return vec3(cos(a) * r, uPadY + 0.015 + aRand.y * 0.04, sin(a) * r);
    }
    return spinAbout(shapeP(i).xyz, shapeS(i), uClock);
  }

  float shapeSize(float i) {
    return i < -0.5 ? 0.6 : shapeP(i).w;
  }

  vec3 shapeColor(float i, float hot) {
    int k = int(max(i, 0.0) + 0.5);
    return mix(uColor[k], uHot[k], hot) * uGain[k];
  }

  void main() {
    vec3 a = shapePos(uFrom);
    vec3 b = shapePos(uTo);

    // Take off when the scan plane is \`lead\` below the destination, land as it arrives.
    float lead = 0.75 + aRand.x * 0.55;
    float t = clamp((uScan - b.y + lead) / lead, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    float flight = sin(3.14159265 * t);

    vec3 p = mix(a, b, t);
    float ph = aRand.w * 6.2831853 + uTime * 0.7;
    p += vec3(cos(ph), 0.55 * sin(ph * 1.3), sin(ph)) * flight * (0.18 + aRand.y * 0.3);

    float heatA = step(2.5, uFrom);
    float heatB = step(2.5, uTo);
    vHeat = mix(heatA, heatB, t);

    // Classified glitch: rare, tiny horizontal slips inside the interference bands.
    vec4 world = modelMatrix * vec4(p, 1.0);
    float slip = step(0.86, fleetNoise1(uTime * 0.9 + 3.0)) * (fleetNoise1(world.y * 7.0 + floor(uTime * 2.0)) - 0.5);
    world.x += slip * 0.12 * vHeat;
    vWorldY = world.y;

    vec4 mv = viewMatrix * world;
    gl_Position = projectionMatrix * mv;

    float size = mix(shapeSize(uFrom), shapeSize(uTo), t) * (1.0 + flight * 0.6);
    float hidden = fleetBehindHorizon(mv.xyz, uHole) * vHeat;
    gl_PointSize = max(uSize * size / -mv.z, uMinSize);

    float hot = smoothstep(0.82, 1.0, aRand.z);
    vColor = mix(shapeColor(uFrom, hot), shapeColor(uTo, hot), t);
    float twinkle = 0.72 + 0.28 * sin(uTime * (0.5 + aRand.y * 1.3) + aRand.w * 40.0);
    vAlpha = uOpacity * (0.42 + 0.58 * aRand.z) * twinkle * (1.0 + flight * 0.9) * (1.0 - hidden);
  }
`

export const swarmFragment = /* glsl */ `
  uniform float uTime;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vWorldY;
  varying float vHeat;

  ${NOISE}

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float halo = smoothstep(0.5, 0.0, d);
    float core = smoothstep(0.2, 0.0, d);
    float scan = 0.8 + 0.2 * sin(vWorldY * 52.0 - uTime * 2.4);
    float hide = fleetInterference(vWorldY, uTime) * vHeat;
    float sweep = fleetSweep(vWorldY, uTime);
    float alpha = (halo * halo * 0.75 + core * 0.55) * vAlpha * (scan + sweep) * (1.0 - hide * 0.9);
    gl_FragColor = vec4(vColor + core * 0.25 + sweep * 0.35, alpha);
  }
`

/* --------------------------------------------------------------------------
 * Line art (wireframes, orbits, pad)
 * ------------------------------------------------------------------------ */
export const lineVertex = /* glsl */ `
  attribute float aAlpha;

  varying float vAlpha;
  varying float vWorldY;
  varying float vDepth;
  varying vec3 vLocal;
  varying vec3 vView;

  void main() {
    vAlpha = aAlpha;
    vLocal = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldY = world.y;
    vec4 mv = viewMatrix * world;
    vDepth = -mv.z;
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`

export const lineFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uCut;     // world-space y of the scan plane
  uniform float uDir;     // +1: visible below the cut (incoming), -1: above (outgoing)
  uniform float uTime;
  uniform float uHeat;
  uniform float uFocus;   // camera distance to the hologram centre
  uniform float uSweep;   // 1 for vehicles, 0 for the pad and scanner
  uniform float uGain;    // lines are 1 device px: brighter on dense displays
  uniform vec4 uHole;     // ZENITH horizon (view-space centre + radius), w = 0: off

  varying float vAlpha;
  varying float vWorldY;
  varying float vDepth;
  varying vec3 vLocal;
  varying vec3 vView;

  ${NOISE}

  void main() {
    float edge = (uCut - vWorldY) * uDir + (fleetNoise3(vLocal * 7.0) - 0.5) * 0.16;
    if (edge < 0.0) discard;
    float seam = 1.0 - smoothstep(0.0, 0.07, edge);
    float scan = 0.74 + 0.26 * sin(vWorldY * 52.0 - uTime * 2.4);
    float depth = clamp(1.0 - (vDepth - uFocus) * 0.38, 0.32, 1.25);
    float hide = fleetInterference(vWorldY, uTime) * uHeat;
    float sweep = fleetSweep(vWorldY, uTime) * uSweep;
    vec3 col = uColor * (scan + sweep) * depth + vec3(0.9, 0.96, 1.0) * (seam * 1.6 + sweep * 0.25);
    float alpha = vAlpha * uOpacity * uGain * (1.0 - hide * 0.88) * max(scan * depth, seam * 2.0);
    alpha *= 1.0 - fleetBehindHorizon(vView, uHole);
    gl_FragColor = vec4(col, alpha);
  }
`

/* --------------------------------------------------------------------------
 * Projector beam: an open cone of light rising from the pad
 * ------------------------------------------------------------------------ */
export const beamVertex = /* glsl */ `
  varying vec2 vUv;
  varying float vRim;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * normal);
    vec3 v = normalize(cameraPosition - world.xyz);
    vRim = 1.0 - abs(dot(n, v));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

export const beamFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;

  varying vec2 vUv;
  varying float vRim;

  ${NOISE}

  void main() {
    float h = vUv.y;
    float fall = pow(1.0 - h, 1.8) * smoothstep(0.0, 0.06, h);
    float streaks = 0.55 + 0.45 * fleetNoise1(vUv.x * 64.0 + uTime * 0.15);
    float rise = 0.75 + 0.25 * sin(h * 34.0 - uTime * 2.6);
    float a = fall * (0.18 + pow(vRim, 2.0) * 0.82) * streaks * rise * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`

/* --------------------------------------------------------------------------
 * Pad floor glow: soft disc with slow outward ripples
 * ------------------------------------------------------------------------ */
export const floorVertex = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const floorFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;

  varying vec2 vUv;

  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float glow = pow(max(1.0 - r, 0.0), 2.6);
    float ripple = 0.5 + 0.5 * sin(r * 26.0 - uTime * 1.4);
    float a = (glow * 0.85 + glow * ripple * 0.35) * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`

/* --------------------------------------------------------------------------
 * ZENITH's event horizon: a camera-facing quad that draws the black shadow,
 * the thin photon ring and the lensed image of the disc arcing over and under
 * it. Premultiplied output (blend ONE, ONE_MINUS_SRC_ALPHA): rgb adds light,
 * alpha darkens what was drawn before it (the beam, the backdrop glow).
 * ------------------------------------------------------------------------ */
export const horizonVertex = /* glsl */ `
  uniform float uExtent;  // quad half-size in world units

  varying vec2 vP;
  varying float vWorldY;

  void main() {
    vP = position.xy * uExtent;
    vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vWorldY = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).y + vP.y;
    gl_Position = projectionMatrix * (centre + vec4(vP, 0.0, 0.0));
  }
`

export const horizonFragment = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;
  uniform float uCut;
  uniform float uDir;
  uniform float uShadow;
  uniform vec3 uColor;
  uniform vec3 uHot;

  varying vec2 vP;
  varying float vWorldY;

  ${NOISE}

  void main() {
    float x = length(vP) / uRadius; // 1.0 at the edge of the shadow
    float a = atan(vP.y, vP.x);

    // Rebuild cut: same plane as the line art.
    float edge = (uCut - vWorldY) * uDir;
    if (edge < 0.0) discard;
    float seam = 1.0 - smoothstep(0.0, 0.06, edge);

    float shadow = 1.0 - smoothstep(0.97, 1.02, x);
    float doppler = 1.0 - 0.5 * cos(a); // approaching (left) side burns brighter
    // Photon ring (+ a faint higher-order image just inside it), Doppler-weighted
    float ring = exp(-pow((x - 1.05) / 0.022, 2.0)) * (0.3 + 0.7 * (doppler - 0.5));
    ring += exp(-pow((x - 1.018) / 0.008, 2.0)) * 0.35;

    // Lensed disc: a band hugging the shadow, widest over the top and bottom.
    float band = smoothstep(1.02, 1.1, x) * (1.0 - smoothstep(1.12, 1.9, x));
    float arcs = mix(0.3, 1.0, pow(abs(sin(a)), 1.3));
    float ang = a - uTime * 0.3;
    vec2 q = vec2(cos(ang), sin(ang)); // seamless around the ring
    float flow = fleetNoise3(vec3(q * 3.2, x * 8.0)) * 0.62 + fleetNoise3(vec3(q * 9.0, x * 21.0 + 4.0)) * 0.38;
    float glow = exp(-max(x - 1.0, 0.0) * 2.6) * step(1.0, x) * 0.16;

    float scan = 0.8 + 0.2 * sin(vWorldY * 52.0 - uTime * 2.4);
    float hide = fleetInterference(vWorldY, uTime);
    float light = (ring * 1.5 + band * arcs * doppler * (0.25 + 0.95 * flow) * 0.75 + glow) * scan * (1.0 - hide * 0.8);

    vec3 col = mix(uColor, uHot, clamp(ring * 0.9 + band * 0.35, 0.0, 1.0)) * light;
    col += vec3(1.0, 0.93, 0.84) * (ring * 0.45 + seam * 0.8 * step(x, 2.2));
    gl_FragColor = vec4(col, shadow * uShadow);
  }
`

/* --------------------------------------------------------------------------
 * Motes: dust drifting up through the projector beam
 * ------------------------------------------------------------------------ */
export const motesVertex = /* glsl */ `
  attribute vec4 aSeed; // x: angle, y: radius, z: speed, w: phase

  uniform float uTime;
  uniform float uSize;
  uniform float uPadY;
  uniform float uHeight;
  uniform float uR0;
  uniform float uR1;

  varying float vAlpha;

  void main() {
    float h = fract(aSeed.w + uTime * (0.018 + aSeed.z * 0.035));
    float radius = mix(uR0, uR1, h) * sqrt(aSeed.y) * 0.86;
    float ang = aSeed.x * 6.2831853 + uTime * 0.06 * (aSeed.z - 0.5);
    vec3 p = vec3(cos(ang) * radius, uPadY + h * uHeight, sin(ang) * radius);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(uSize * (0.5 + aSeed.y * 0.8) / -mv.z, 1.0);
    float twinkle = 0.55 + 0.45 * sin(uTime * (0.8 + aSeed.z * 2.2) + aSeed.w * 37.0);
    vAlpha = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.45, 1.0, h)) * twinkle;
  }
`

export const motesFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor * 0.7 + 0.3, a * a * vAlpha * uOpacity);
  }
`
