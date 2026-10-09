/**
 * Hero GLSL.
 *
 * The planet, atmosphere, sky and lens flare are ray-traced analytically in a
 * single full-screen pass (a mesh silhouette could never give a perfectly
 * smooth, razor-thin limb at this scale). Stars and the neural network are
 * cheap additive point / line layers drawn on top, each doing its own
 * planet-occlusion test in the vertex shader.
 *
 * Units: planet radius = 1. The limb is art-directed in CSS pixels: `lp` is
 * the signed distance of a view ray from the limb, measured in CSS px
 * (positive = above the horizon), so the glow looks identical at any
 * resolution, aspect or camera altitude.
 */

const NOISE = /* glsl */ `
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Value noise, smooth (C2) interpolation, range [0, 1]
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = hash13(i);
    float b = hash13(i + vec3(1.0, 0.0, 0.0));
    float c = hash13(i + vec3(0.0, 1.0, 0.0));
    float d = hash13(i + vec3(1.0, 1.0, 0.0));
    float e = hash13(i + vec3(0.0, 0.0, 1.0));
    float f1 = hash13(i + vec3(1.0, 0.0, 1.0));
    float g = hash13(i + vec3(0.0, 1.0, 1.0));
    float h = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
      mix(mix(e, f1, u.x), mix(g, h, u.x), u.y),
      u.z
    );
  }

  const mat3 OCT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

  // Band-limited fbm: \`fw\` is the pixel footprint in noise units, octaves
  // finer than a pixel fade to their mean so distant clouds never shimmer.
  float fbm(vec3 p, float fw, const int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      float keep = 1.0 - smoothstep(0.18, 0.6, fw);
      sum += amp * mix(0.5, vnoise(p), keep);
      norm += amp;
      p = OCT * p * 2.03;
      fw *= 2.03;
      amp *= 0.5;
    }
    return sum / norm;
  }
`

/** GLSL twin of \`continents()\` in network.js — same integer hash, so the
 *  city lights sit exactly on the land the shader draws. */
const CONTINENTS = /* glsl */ `
  float ihash(vec3 c) {
    ivec3 i = ivec3(c);
    uint h = (uint(i.x) * 374761393u) ^ (uint(i.y) * 668265263u) ^ (uint(i.z) * 1274126177u);
    h = (h ^ (h >> 13u)) * 1103515245u;
    h = h ^ (h >> 16u);
    return float(h) / 4294967296.0;
  }

  float cnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(ihash(i), ihash(i + vec3(1, 0, 0)), u.x), mix(ihash(i + vec3(0, 1, 0)), ihash(i + vec3(1, 1, 0)), u.x), u.y),
      mix(mix(ihash(i + vec3(0, 0, 1)), ihash(i + vec3(1, 0, 1)), u.x), mix(ihash(i + vec3(0, 1, 1)), ihash(i + vec3(1, 1, 1)), u.x), u.y),
      u.z
    );
  }

  float continents(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    float f = 9.0;
    float norm = 0.0;
    for (int i = 0; i < 4; i++) {
      sum += amp * cnoise(vec3(p.x * f + 3.1, p.y * f + 7.7, p.z * f + 1.3));
      norm += amp;
      f *= 2.07;
      amp *= 0.5;
    }
    return sum / norm;
  }
`

export const fullscreenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

export const skyFragment = /* glsl */ `
  precision highp float;

  uniform vec2 uRes;          // drawing buffer, px
  uniform float uPR;          // buffer px per CSS px
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;
  uniform vec3 uSunDir;
  uniform vec2 uSunPx;        // flare source, buffer px
  uniform vec2 uLimbDir;      // screen-space tangent of the limb at the sun
  uniform float uSunVis;      // 0 hidden behind the planet → 1 fully risen
  uniform float uSunR;        // sun radius, CSS px
  uniform float uDh;          // distance from camera to the horizon
  uniform float uPixAngle;    // radians per CSS px
  uniform float uTime;
  uniform float uLight;       // master exposure (intro fade-up)
  uniform float uReveal;      // limb reveal sweep, spreads out from the sun
  uniform float uFlare;       // lens flare strength
  uniform float uRise;        // scroll progress: sunrise
  uniform float uCrest;       // 0 → 1 → 0: the instant the disc breaks the limb
  uniform mat3 uCloudRot;
  uniform vec3 uGalN;         // galactic plane normal (Milky Way)

  varying vec2 vUv;

  #ifndef CLOUD_OCTAVES
  #define CLOUD_OCTAVES 5
  #endif

  ${NOISE}
  ${CONTINENTS}

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 v = uInvProj * vec4(ndc, 1.0, 1.0);
    vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
    vec3 ro = uCamPos;

    // Ray / planet. s ≈ altitude of the ray's closest approach (planet radii),
    // negative when the ray strikes the surface.
    float b = dot(ro, rd);
    float c = dot(ro, ro) - 1.0;
    float disc = b * b - c;
    bool hit = disc > 0.0 && b < 0.0;
    float s = b < 0.0 ? -0.5 * disc : length(ro) - 1.0;
    float lp = s / (uDh * uPixAngle);   // CSS px from the limb (+ above)

    // Angular distance to the sun along the sky
    float cs = clamp(dot(rd, uSunDir), -1.0, 1.0);
    float az = acos(cs);
    float sunWide = exp(-az * 2.1);
    float sunMid = exp(-az * 7.5);
    float sunNear = exp(-az * 26.0);
    float dawn = 0.55 + 0.45 * uRise;     // the sky warms as the sun rises

    // Limb reveal: lights up outward from the sun during the intro
    float revealEdge = uReveal * 3.4;
    float reveal = 1.0 - smoothstep(revealEdge - 0.55, revealEdge, az);
    reveal *= smoothstep(0.0, 0.15, uReveal);

    vec3 col = vec3(0.0);

    if (!hit) {
      // ---- Deep sky: faint Milky Way band ---------------------------------
      float g = dot(rd, uGalN);
      float band = exp(-g * g / 0.007);
      if (band > 0.004) {   // only pay for the noise inside the band
        float clump = fbm(rd * 8.0 + 2.1, 0.0, 5);
        float dust = smoothstep(0.47, 0.68, fbm(rd * 15.0 + 7.3, 0.0, 4));
        vec3 tint = mix(vec3(0.26, 0.38, 0.80), vec3(0.74, 0.76, 0.84), exp(-g * g / 0.0012));
        vec3 mw = tint * band * (0.1 + 1.4 * clump * clump);
        float lanes = 1.0 - dust * 0.75 * smoothstep(0.0, 0.5, band);
        // Unresolved star clouds: the peaks of a fine noise lattice (~1.6 px,
        // scaled to the pixel so they glide rather than crawl; rotated so no
        // lattice artefact lines up with the screen), denser where it clumps
        float specks = smoothstep(0.91 - 0.14 * clump, 1.0, vnoise(OCT * rd * (0.62 / uPixAngle)));
        // fades toward the bright limb, where airglow would drown it
        float limbFade = smoothstep(10.0, 160.0, lp);
        col += (mw * 0.026 + vec3(0.7, 0.8, 1.0) * specks * band * 0.13) * lanes * limbFade;
      }

      // ---- Atmospheric limb (sky side) ------------------------------------
      float x = max(lp, 0.0);
      float core = exp(-x / 0.9);
      float inner = exp(-x / 3.6);
      float blue = exp(-x / 11.0);
      float haze = exp(-x / 42.0);
      float veil = exp(-x / 180.0);
      // Layered like a real orbital sunrise: red-orange at the base, gold,
      // white, then Rayleigh blue fading to black. Away from the sun the
      // limb thins to a cold blue hairline.
      vec3 coreCol = mix(vec3(0.62, 0.84, 1.0), vec3(1.0, 0.70, 0.40), sunMid);
      vec3 limb = coreCol * core * (0.9 + 4.0 * sunMid + 1.1 * sunWide);
      limb += vec3(1.0, 0.30, 0.06) * exp(-pow((x - 0.8) / 1.6, 2.0)) * (3.2 * sunMid + 0.5 * sunWide);
      limb += vec3(1.0, 0.68, 0.30) * exp(-pow((x - 2.6) / 2.4, 2.0)) * (2.2 * sunNear + 0.8 * sunMid + 0.08 * sunWide);
      limb += vec3(0.20, 0.52, 1.0) * inner * (0.45 + 1.5 * sunWide);
      limb += vec3(0.06, 0.24, 0.95) * blue * (0.14 + 0.7 * sunWide);
      limb += vec3(0.04, 0.12, 0.50) * haze * (0.012 + 0.12 * sunWide) * dawn;
      limb += vec3(0.04, 0.10, 0.42) * veil * 0.06 * sunMid * dawn;
      // Dawn dome: warm light pooling just above the hidden sun. Kept tight
      // (gaussian in height) — a dim orange tail over black reads as brown
      // haze, so higher up the dawn turns to deep Rayleigh blue instead.
      limb += vec3(1.0, 0.56, 0.20) * exp(-x / 9.0 - x * x / 900.0) * sunNear * 0.9;
      limb += vec3(1.0, 0.46, 0.14) * exp(-x * x / 200.0) * sunMid * (0.08 + 0.1 * uRise);
      limb += vec3(0.08, 0.26, 1.0) * exp(-x / 70.0) * sunMid * 0.03 * dawn;
      col += limb * reveal;

      // ---- Sun disc (world space, so the planet occludes it) --------------
      float sunR = uSunR * uPixAngle;
      float disc0 = smoothstep(sunR, sunR * 0.55, az);
      col += vec3(1.0, 0.95, 0.86) * disc0 * 14.0;
    } else {
      // ---- Planet surface ---------------------------------------------------
      float t = -b - sqrt(disc);
      vec3 p = ro + rd * t;
      vec3 n = normalize(p);
      float mu = max(dot(n, -rd), 0.0);
      float fpx = t * uPixAngle / uPR / max(mu, 0.035);   // world size of a pixel

      vec3 q = uCloudRot * n;
      // Weather systems: domain-warped fbm
      vec3 wq = q * 3.1;
      vec3 warp = vec3(vnoise(wq + 1.7), vnoise(wq + 9.2), vnoise(wq + 4.4)) - 0.5;
      float cl = fbm(q * 15.0 + warp * 2.6, fpx * 15.0, CLOUD_OCTAVES);
      float cloud = smoothstep(0.46, 0.74, cl);
      float landN = continents(n);
      float land = smoothstep(0.49, 0.51, landN);
      float relief = fbm(n * 60.0, fpx * 60.0, 3);

      float sd = dot(n, uSunDir);
      float day = smoothstep(-0.015, 0.16, sd);
      float twi = exp(-pow((sd - 0.01) / 0.045, 2.0));

      vec3 night = mix(vec3(0.0015, 0.0035, 0.010), vec3(0.006, 0.0075, 0.012) * (0.7 + 0.6 * relief), land);
      vec3 dayCol = mix(vec3(0.010, 0.040, 0.110), vec3(0.070, 0.065, 0.050), land);
      vec3 surf = mix(night, dayCol, day);

      // Ocean: a dark mirror catching the dawn along the horizon
      float fres = pow(1.0 - mu, 12.0);
      vec3 rfl = reflect(rd, n);
      float sheen = pow(max(dot(rfl, uSunDir), 0.0), 60.0);
      surf += (1.0 - land) * (fres * vec3(0.02, 0.06, 0.18) * (0.2 + sunWide)
        + sheen * fres * vec3(1.0, 0.55, 0.25) * 0.9);

      vec3 cloudCol = vec3(0.014, 0.022, 0.042)          // moonlit / airglow
        + vec3(0.95, 0.93, 0.90) * day
        + vec3(1.0, 0.40, 0.16) * twi * 0.9;
      surf = mix(surf, cloudCol, cloud * (0.55 + 0.45 * day));

      // Ocean sun glint
      vec3 rf = reflect(rd, n);
      float glint = pow(max(dot(rf, uSunDir), 0.0), 900.0) * (1.0 - land) * (1.0 - cloud) * day;
      surf += vec3(1.0, 0.82, 0.58) * glint * 8.0;

      // Aerial perspective: haze thickens toward the horizon
      // (deep blue; warm only in the last sliver before the horizon under the
      // sun, so the twilight zone glows rather than turning muddy)
      float graze = 1.0 - mu;
      vec3 hazeCol = mix(vec3(0.016, 0.05, 0.17), vec3(0.62, 0.27, 0.08), sunMid * 0.85 * pow(graze, 60.0));
      surf = mix(surf, hazeCol, pow(graze, 14.0) * (0.15 + 0.85 * sunWide) * reveal);

      // Limb glow continues just below the horizon
      float y = min(lp, 0.0);
      vec3 under = vec3(0.32, 0.62, 1.0) * exp(y / 1.6) * (0.3 + 1.2 * sunMid);
      under += vec3(1.0, 0.42, 0.12) * exp(y / 4.0) * (1.1 * sunMid + 0.08 * sunWide);
      under += vec3(0.04, 0.13, 0.42) * exp(y / 18.0) * (0.04 + 0.22 * sunWide);
      col += surf + under * reveal;
    }

    // ---- Lens: bloom, anamorphic streak, starburst, ghosts -----------------
    vec2 d = (gl_FragCoord.xy - uSunPx) / uPR;
    float r = length(d);
    vec2 cssRes = uRes / uPR;
    float minDim = min(cssRes.x, cssRes.y);
    float W = cssRes.x;
    float vis = uSunVis;

    float crest = uCrest;
    vec3 fl = vec3(0.0);
    // Limb-aligned frame: along / across the horizon at the sun
    vec2 dl = vec2(dot(d, uLimbDir), dot(d, vec2(-uLimbDir.y, uLimbDir.x)));
    float re = length(vec2(dl.x * 0.4, dl.y));          // glow spreads along the limb
    // Glare: white-hot and compact. The warm colour lives in the thin
    // atmospheric band itself (sky pass above) — a big dim orange halo here
    // would only read as brown smog once tone-mapped.
    fl += vec3(1.0, 0.88, 0.72) * exp(-r / (0.011 * minDim)) * (0.55 + 2.5 * vis + 2.6 * crest);
    fl += vec3(1.0, 0.74, 0.46) * exp(-pow(re / (0.04 * minDim), 2.0)) * (0.07 + 0.18 * vis + 0.4 * crest);
    // Scatter: a broad, faint veil in deep blue so the sky deepens, never greys
    fl += vec3(0.08, 0.26, 1.00) * exp(-r / (0.24 * minDim)) * (0.004 + 0.018 * vis);

    // Anamorphic streak — a razor of blue-white light laid along the limb.
    // As the disc breaks the horizon it shoots across the whole frame.
    float sy = abs(dl.y);
    float sx = abs(dl.x);
    float along = sx / W;
    float reach = 0.065 + 0.03 * vis + 0.22 * crest;
    fl += vec3(0.72, 0.86, 1.0) * exp(-sy / (0.7 + 0.5 * crest)) * exp(-along / reach - along * along / (0.02 + 0.3 * crest))
      * (0.22 + 0.85 * vis + 1.1 * crest);
    fl += vec3(0.22, 0.46, 1.0) * exp(-sy / 4.5) * exp(-along / (0.075 + 0.12 * crest) - along * along / 0.03) * (0.05 + 0.26 * vis + 0.3 * crest);

    // Starburst: fine diffraction spikes, slowly breathing
    float ang = atan(d.y, d.x);
    float rays = pow(abs(cos(ang * 3.0 + 0.3)), 80.0) + 0.55 * pow(abs(cos(ang * 7.0 + 1.1)), 120.0);
    rays *= 0.6 + 0.4 * sin(ang * 23.0 + uTime * 0.15);
    fl += vec3(1.0, 0.9, 0.76) * rays * exp(-r / ((0.03 + 0.03 * crest) * minDim)) * (vis * 0.6 + crest * 0.9);

    // Ghosts, mirrored through the frame centre — small and quiet; they only
    // really appear in the instant the disc clears the limb
    vec2 axis = (uRes * 0.5 - uSunPx) / uPR;
    vec3 ghosts = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      float k = i == 0 ? 0.55 : i == 1 ? 1.2 : 1.6;
      float size = (i == 0 ? 0.014 : i == 1 ? 0.026 : 0.009) * minDim;
      vec3 tint = i == 0 ? vec3(0.3, 0.6, 1.0) : i == 1 ? vec3(0.4, 0.62, 1.0) : vec3(1.0, 0.66, 0.36);
      float gd = length(d - axis * k);
      float disk = smoothstep(size, size * 0.4, gd);
      float ring = exp(-pow((gd - size) / (size * 0.1), 2.0));
      ghosts += tint * (disk * 0.4 + ring * 0.3);
    }
    fl += ghosts * 0.004 * (vis * 0.6 + crest * 1.4);

    col += fl * uFlare;

    // ---- Output ------------------------------------------------------------
    col *= uLight * 1.5;
    col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);  // ACES fit
    col = pow(col, vec3(1.0 / 2.2));

    vec2 vc = vUv - 0.5;
    col *= 1.0 - 0.28 * dot(vc, vc) * 1.6;           // gentle vignette

    // Dither (kills banding in the black-to-blue gradients)
    col += (hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
    gl_FragColor = vec4(col, 1.0);
  }
`

/* ---------------------------------------------------------------------------
 * Stars — directions on a large sphere around the camera.
 * ------------------------------------------------------------------------ */
export const starVertex = /* glsl */ `
  attribute float aMag;
  attribute float aSeed;
  attribute vec3 aColor;

  uniform float uTime;
  uniform float uPR;
  uniform float uLight;
  uniform float uDh;
  uniform float uPixAngle;
  uniform vec3 uSunDir;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpike;

  void main() {
    vec3 d = normalize(position);

    // Hidden behind the planet / drowned by the atmosphere near the limb
    float b = dot(cameraPosition, d);
    float c = dot(cameraPosition, cameraPosition) - 1.0;
    float s = b < 0.0 ? -0.5 * (b * b - c) : length(cameraPosition) - 1.0;
    float lp = s / (uDh * uPixAngle);
    float vis = smoothstep(3.0, 40.0, lp);
    // ...and washed out near the sun
    float az = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
    vis *= smoothstep(0.04, 0.5, az);

    float tw = 1.0 + 0.38 * sin(uTime * (0.6 + aSeed * 2.4) + aSeed * 91.0) * step(0.45, fract(aSeed * 13.7));

    vec4 mv = viewMatrix * vec4(cameraPosition + d * 100.0, 1.0);
    gl_Position = projectionMatrix * mv;

    float size = 1.0 + aMag * 3.2;
    gl_PointSize = max(size * uPR, 1.0);
    vColor = aColor;
    vAlpha = (0.24 + aMag * 1.5) * tw * vis * uLight;
    vSpike = smoothstep(0.82, 1.0, aMag);
  }
`

export const starFragment = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpike;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    float core = exp(-r * r * 9.0);
    float spike = vSpike * (exp(-abs(p.x) * 40.0) + exp(-abs(p.y) * 40.0)) * (1.0 - r) * 0.5;
    float a = (core + max(spike, 0.0)) * vAlpha;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`

/* ---------------------------------------------------------------------------
 * Neural network — nodes (points) on the night side of the planet.
 * ------------------------------------------------------------------------ */
const NET_COMMON = /* glsl */ `
  uniform float uTime;
  uniform float uPR;
  uniform float uNet;         // intro: network wakes up 0 → 1
  uniform float uLight;
  uniform vec3 uSunDir;
  uniform float uPxPerUnit;   // CSS px per world unit at distance 1
  uniform float uNodeScale;   // larger lights when the camera flies higher
  uniform vec3 uFocus;        // cursor attention: xy = NDC, z = strength
  uniform float uAspect;

  // The network wakes where the visitor looks: a soft screen-space falloff
  // around the cursor (~160 px), so the effect reads the same at any depth
  float focusAt(vec4 clip) {
    vec2 d = (clip.xy / max(clip.w, 1e-4) - uFocus.xy) * vec2(uAspect, 1.0);
    return exp(-dot(d, d) / 0.06) * uFocus.z;
  }

  // Visible from the camera? (segment camera → p not blocked by the planet)
  float planetVisibility(vec3 p) {
    vec3 ro = cameraPosition;
    vec3 v = p - ro;
    float len = length(v);
    vec3 rd = v / len;
    float b = dot(ro, rd);
    float c = dot(ro, ro) - 0.99996;
    float h = b * b - c;
    if (h < 0.0) return 1.0;
    float t = -b - sqrt(h);
    return smoothstep(-0.0015, 0.0015, t - len);
  }

  float nightMask(vec3 n) {
    return 1.0 - smoothstep(-0.06, 0.07, dot(n, uSunDir));
  }

  // Intro cascade: each element switches on at its own delay
  float wake(float delay) {
    return smoothstep(delay, delay + 0.12, uNet * 1.12);
  }
`

export const nodeVertex = /* glsl */ `
  attribute float aSize;
  attribute float aBright;
  attribute float aSeed;
  attribute float aDelay;
  attribute float aHalo;

  ${NET_COMMON}

  varying float vAlpha;
  varying float vHalo;
  varying vec3 vColor;

  void main() {
    vec3 p = position;
    vec3 n = normalize(p);
    vec3 toCam = cameraPosition - p;
    float dist = length(toCam);
    float mu = dot(n, toCam / dist);

    float vis = planetVisibility(p) * smoothstep(0.0, 0.06, mu) * nightMask(n);

    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float focus = focusAt(gl_Position);

    // Synapse firing: rare, sharp flashes — far more of them under the cursor
    float phase = uTime * (0.18 + aSeed * 0.25) + aSeed * 37.0;
    float fire = pow(max(sin(phase), 0.0), mix(120.0, 26.0, focus))
      * step(0.55 - 0.5 * focus, fract(aSeed * 7.31)) * (1.0 - aHalo);
    float breathe = 0.85 + 0.15 * sin(uTime * 0.9 + aSeed * 21.0);

    float w = wake(aDelay);
    float flash = (1.0 - smoothstep(0.0, 0.35, uNet * 1.12 - aDelay)) * step(aDelay, uNet * 1.12) * (1.0 - aHalo);

    float px = aSize * uNodeScale * uPxPerUnit / dist;
    gl_PointSize = max(px, 1.6) * uPR;
    float shrink = min(px / 1.6, 1.0);   // keep sub-pixel nodes dim, not chunky

    vHalo = aHalo;
    vColor = mix(vec3(0.62, 0.84, 1.0), vec3(1.0, 0.94, 0.86), aBright * 0.45);
    if (aHalo > 0.5) vColor = vec3(0.16, 0.42, 1.0);
    vAlpha = aBright * (breathe * (1.0 + 1.8 * focus) + fire * 3.0 + flash * 2.5) * vis * w * shrink * uLight;
  }
`

export const nodeFragment = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  varying float vHalo;
  varying vec3 vColor;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r2 = dot(p, p) * 4.0;
    float a;
    if (vHalo > 0.5) {
      a = exp(-r2 * 3.2) * (1.0 - smoothstep(0.7, 1.0, r2));
    } else {
      a = exp(-r2 * 14.0) + exp(-r2 * 3.5) * 0.22;
      a *= 1.0 - smoothstep(0.75, 1.0, r2);
    }
    a *= vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`

/* ---------------------------------------------------------------------------
 * Filaments — local synapses + long arcs, with travelling pulses.
 * ------------------------------------------------------------------------ */
export const linkVertex = /* glsl */ `
  attribute float aT;          // 0 → 1 along the link
  attribute float aSeed;
  attribute float aKind;       // 0 local synapse, 1 long-haul arc
  attribute float aDelay;

  ${NET_COMMON}

  varying float vT;
  varying float vSeed;
  varying float vKind;
  varying float vAlpha;
  varying float vFocus;

  void main() {
    vec3 p = position;
    vec3 n = normalize(p);
    vec3 toCam = cameraPosition - p;
    float dist = length(toCam);
    float mu = dot(n, toCam / dist);
    float vis = planetVisibility(p) * nightMask(n);
    vis *= aKind > 0.5 ? smoothstep(-0.02, 0.05, mu) : smoothstep(0.0, 0.08, mu);

    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    vFocus = focusAt(gl_Position);
    vT = aT;
    vSeed = aSeed;
    vKind = aKind;
    // Gently brighter up close, fading into the haze toward the horizon —
    // filaments are a whisper; the lights and pulses carry the image
    float nearK = clamp(0.2 / dist, 0.5, 1.15);
    vAlpha = vis * wake(aDelay) * nearK * uLight;
  }
`

export const linkFragment = /* glsl */ `
  precision highp float;
  uniform float uTime;
  varying float vT;
  varying float vSeed;
  varying float vKind;
  varying float vAlpha;
  varying float vFocus;

  void main() {
    float arc = step(0.5, vKind);
    // Uneven strengths keep the web organic rather than a uniform wireframe
    float strength = 0.25 + 0.95 * pow(fract(vSeed * 7.77), 1.6);
    float base = mix(0.085 * strength, 0.1, arc);
    // Arcs fade in from their endpoints like a data link drawn in the sky
    base *= mix(1.0, 0.3 + 0.7 * sin(3.14159 * vT), arc);

    // Pulse: a bright head with a soft tail
    float speed = mix(0.22, 0.12, arc) * (0.6 + vSeed * 0.8);
    float head = fract(uTime * speed + vSeed * 17.0);
    float dir = step(0.5, fract(vSeed * 5.3));
    float tt = mix(vT, 1.0 - vT, dir);
    float dt = head - tt;
    float pulse = exp(-dt * dt / 0.0012) + (dt > 0.0 ? exp(-dt / 0.09) * 0.45 : 0.0);
    // ...and under the cursor most synapses start carrying signal
    float pulseOn = arc > 0.5 ? 1.0 : step(0.72 - 0.6 * vFocus, fract(vSeed * 3.71));
    pulse *= pulseOn;

    vec3 col = mix(vec3(0.24, 0.52, 1.0), vec3(0.4, 0.68, 1.0), arc) * base * (1.0 + 6.0 * vFocus);
    col += vec3(0.85, 0.95, 1.0) * pulse * mix(0.75, 0.9, arc) * (1.0 + 1.2 * vFocus);
    float a = vAlpha;
    gl_FragColor = vec4(col * a, 1.0);
  }
`
