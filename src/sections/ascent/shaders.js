/**
 * GLSL for the Ascent scene. Written GLSL1-style; three.js upgrades it for
 * WebGL2. Colors are authored directly in display (sRGB) space — these
 * materials skip three's color management on purpose.
 */

/** Shared hash / value-noise / fbm. `FBM_OCT` is defined per tier. */
export const NOISE = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  const mat2 FBM_ROT = mat2(1.6, 1.2, -1.2, 1.6);
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < FBM_OCT; i++) {
      v += a * vnoise(p);
      p = FBM_ROT * p;
      a *= 0.5;
    }
    return v;
  }
  float fbm3(vec2 p) {
    float v = 0.5 * vnoise(p);
    p = FBM_ROT * p;
    v += 0.25 * vnoise(p);
    p = FBM_ROT * p;
    v += 0.125 * vnoise(p);
    return v / 0.875;
  }
`

/** Full-screen quad: clip-space positions straight from a 1×1 plane. */
export const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
  }
`

/**
 * Background: sky gradient, stars + galaxy, distant horizon, launch pad and
 * tower (in world units, so it tracks the rocket exactly), floodlight beams,
 * far cloud decks, exhaust trail and — in orbit — Earth's limb at sunrise.
 */
export const SKY_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uRes;
  uniform float uTime;
  uniform float uPxScale;
  uniform vec2 uCam;
  uniform float uViewH;
  uniform float uSky;
  uniform float uStars;
  uniform float uGround;
  uniform float uHorizon;
  uniform float uSunX;
  uniform float uFire;
  uniform vec2 uFirePos;
  uniform float uFlood;
  uniform float uArm;
  uniform float uUmb;
  uniform vec2 uCloudY;
  uniform float uCloudAmt;
  uniform float uFlow;
  uniform vec2 uTrailA;
  uniform vec2 uTrailDir;
  uniform float uTrailLen;
  uniform float uTrailAmt;
  uniform float uTrailLit;
  uniform float uEarth;
  uniform float uEarthTop;
  uniform float uEarthR;
  uniform float uNight;
  uniform float uSun;
  uniform float uDawn;
  uniform float uSunA;
  uniform float uTowerX;

  ${NOISE}

  vec3 pal(vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4, float a) {
    float k = clamp(a, 0.0, 1.0) * 4.0;
    vec3 c = mix(c0, c1, smoothstep(0.0, 1.0, k));
    c = mix(c, c2, smoothstep(1.0, 2.0, k));
    c = mix(c, c3, smoothstep(2.0, 3.0, k));
    return mix(c, c4, smoothstep(3.0, 4.0, k));
  }

  vec3 skyGradient(float y, float a) {
    // y: 0 = bottom of frame, 1 = top. Keys: dawn pad, troposphere, stratosphere, mesosphere, space.
    vec3 lo = pal(vec3(0.23, 0.42, 0.66), vec3(0.32, 0.6, 0.88), vec3(0.11, 0.3, 0.68), vec3(0.13, 0.07, 0.34), vec3(0.012, 0.012, 0.035), a);
    vec3 mi = pal(vec3(0.05, 0.14, 0.31), vec3(0.12, 0.36, 0.7), vec3(0.03, 0.12, 0.4), vec3(0.04, 0.025, 0.15), vec3(0.0, 0.0, 0.008), a);
    vec3 hi = pal(vec3(0.008, 0.02, 0.055), vec3(0.04, 0.15, 0.4), vec3(0.008, 0.035, 0.14), vec3(0.004, 0.0, 0.03), vec3(0.0), a);
    vec3 c = mix(lo, mi, smoothstep(0.0, 0.5, y));
    return mix(c, hi, smoothstep(0.42, 1.05, y));
  }

  float starLayer(vec2 px, float cell, float density, float size, float seed) {
    vec2 g = px / cell + seed;
    vec2 id = floor(g);
    vec2 f = fract(g);
    vec2 h = hash22(id);
    float present = step(density, hash12(id + 7.13));
    vec2 c = 0.2 + 0.6 * h;
    float d = length(f - c) * cell;
    float r = size * mix(0.55, 1.35, hash12(id + 3.7)) * uPxScale;
    float tw = 0.7 + 0.3 * sin(uTime * (0.8 + 2.5 * h.x) + h.y * 40.0);
    float b = mix(0.35, 1.0, hash12(id + 1.9));
    return present * b * tw * (smoothstep(r, 0.0, d) + 0.25 * smoothstep(r * 3.5, 0.0, d));
  }

  // Lattice launch tower, in world units. Returns coverage (0..1).
  float towerMask(vec2 w, float px, out float lightHit) {
    lightHit = 0.0;
    vec2 p = w - vec2(uTowerX, -0.55);
    float W = 0.92;
    float H = 13.0;
    if (p.x < -1.0 || p.x > W + 0.3 || p.y < -0.1 || p.y > H + 2.6) return 0.0;
    float d = 1e3;
    if (p.y < H) {
      float legs = min(abs(p.x - 0.05), abs(p.x - (W - 0.05))) - 0.05;
      float bay = 0.92;
      float fy = fract(p.y / bay) * bay;
      float girder = min(fy, bay - fy) - 0.028;
      float len = length(vec2(W, bay));
      float diag1 = abs(p.x * bay - fy * W) / len - 0.016;
      float diag2 = abs((W - p.x) * bay - fy * W) / len - 0.016;
      float inside = step(0.0, p.x) * step(p.x, W);
      d = legs;
      if (inside > 0.5) d = min(d, min(girder, min(diag1, diag2)));
      // tower lights at every third bay
      float bi = floor(p.y / bay);
      if (mod(bi, 3.0) == 1.0) {
        vec2 lp = vec2(W - 0.05, (bi + 0.5) * bay);
        lightHit += smoothstep(0.09, 0.0, length(p - lp));
      }
    }
    // cap + lightning mast + top light
    d = min(d, max(abs(p.x - W * 0.5) - W * 0.5 - 0.06, abs(p.y - H) - 0.06));
    d = min(d, max(abs(p.x - W * 0.5) - 0.022, abs(p.y - (H + 1.2)) - 1.2));
    lightHit += smoothstep(0.12, 0.0, length(p - vec2(W * 0.5, H + 2.42)));
    // crew-access arm (fairing level) swings away during the count
    float armL = mix(-0.78, -0.05, uArm);
    if (p.x > armL && p.x < 0.05) {
      float ay = p.y - 10.15;
      float chords = abs(abs(ay) - 0.1) - 0.02;
      float struts = max(abs(fract(p.x * 4.0) - 0.5) / 4.0 - 0.012, abs(ay) - 0.1);
      float cabin = max(abs(ay) - 0.13, abs(p.x - (armL + 0.13)) - 0.13);
      d = min(d, min(min(chords, struts), cabin));
    }
    // umbilical arm (interstage level) drops away at liftoff
    float umbL = mix(-0.84, -0.1, uUmb);
    if (p.x > umbL && p.x < 0.05) {
      float uy = 6.5 - uUmb * 0.9;
      d = min(d, abs(p.y - uy) - 0.07);
    }
    return 1.0 - smoothstep(-px, px, d);
  }

  vec4 cloudDeck(vec2 q, float bandY, float thick, float scale, float seed, vec3 lit, vec3 shade) {
    float dy = (q.y - bandY) / thick;
    float env = exp(-dy * dy * 1.8);
    if (env < 0.02) return vec4(0.0);
    // billows, only slightly squashed, so the decks read as cumulus rather than smears
    vec2 cp = vec2(q.x * scale + seed + uTime * 0.012, (q.y - bandY) * scale * 1.25 + uFlow * 0.15 + seed * 0.37);
    vec2 warp = vec2(fbm3(cp * 0.55 + 3.1), fbm3(cp * 0.55 + 8.7));
    vec2 bp = cp + warp * 1.4;
    float n = fbm(bp);
    // two erosion scales carve crisp, cauliflower edges into the soft base shape
    float detail = fbm3(bp * 3.4 + 5.0);
    float fine = vnoise(bp * 11.0 + 2.0);
    float shape = n * (0.55 + 0.6 * env) - (detail - 0.5) * 0.16 - (fine - 0.5) * 0.05;
    float dens = smoothstep(0.495, 0.555, shape);
    // sunlit from above-right: density falling toward the sun means a lit face
    float n2 = fbm(bp + vec2(0.1, 0.22));
    float light = clamp((n - n2) * 8.0 + 0.7 + (detail - 0.5) * 0.6, 0.0, 1.0);
    // thin edges catch the light (silver lining)
    float rim = smoothstep(0.495, 0.515, shape) * (1.0 - smoothstep(0.515, 0.58, shape));
    vec3 c = mix(shade, lit, light) + lit * rim * 0.22;
    return vec4(c, dens * smoothstep(0.02, 0.35, env));
  }

  void main() {
    float aspect = uRes.x / uRes.y;
    vec2 q = (vUv - 0.5) * vec2(aspect, 1.0) * 2.0;
    vec2 w = uCam + q * uViewH * 0.5;
    float pxW = uViewH / uRes.y * 1.4;

    // --- sky ---------------------------------------------------------------
    vec3 col = skyGradient(vUv.y, uSky);

    // sunward brightening (dawn) — the sun is low on the right
    float sx = (q.x - uSunX) * 0.55;
    float sunSide = exp(-sx * sx);
    col += vec3(0.2, 0.32, 0.5) * sunSide * 0.18 * (1.0 - smoothstep(0.35, 0.7, uSky)) * (1.0 - vUv.y);

    // --- stars + galaxy ------------------------------------------------------
    if (uStars > 0.001) {
      vec2 px = gl_FragCoord.xy / uPxScale;
      float s = starLayer(px, 110.0, 0.55, 1.3, 0.0)
              + starLayer(px, 52.0, 0.7, 1.0, 17.0)
              + starLayer(px, 26.0, 0.8, 0.75, 41.0);
      vec2 g = q;
      float band = dot(g, normalize(vec2(-0.55, 1.0))) - 0.35;
      float milky = exp(-band * band * 3.5) * fbm(g * 1.6 + 4.0);
      float dust = smoothstep(0.45, 0.75, fbm(g * 4.0 + 11.0));
      vec3 gal = vec3(0.32, 0.35, 0.6) * milky * (1.0 - 0.7 * dust) * 0.22;
      gal += vec3(0.5, 0.3, 0.65) * exp(-band * band * 12.0) * 0.03;
      col += (vec3(0.85, 0.92, 1.0) * s + gal) * uStars;
    }

    // --- horizon, ground & pad ------------------------------------------------
    if (uGround > 0.001) {
      float above = q.y - uHorizon;
      // pale glow just above the horizon, warmer toward the sun
      float hg = exp(-max(above, 0.0) * 5.5) * step(0.0, above);
      col += hg * (vec3(0.16, 0.3, 0.46) + vec3(0.9, 0.5, 0.28) * 0.45 * sunSide) * uGround;
      col += exp(-max(above, 0.0) * 40.0) * step(0.0, above) * vec3(0.9, 0.62, 0.42) * 0.25 * sunSide * uGround;

      // distant coastline silhouette + far lights
      float land = 0.012 + 0.018 * fbm3(vec2(q.x * 2.5, 3.0)) + 0.02 * smoothstep(0.4, 1.0, vnoise(vec2(q.x * 7.0, 1.0)));
      if (above < land) {
        float depth = max(-above, 0.0);
        vec3 g = mix(vec3(0.045, 0.075, 0.12), vec3(0.008, 0.011, 0.018), smoothstep(0.0, 0.35, depth));
        // water: streaks of reflected dawn light
        float rip = vnoise(vec2(q.x * 6.0, depth * 260.0 / (depth * 4.0 + 0.2)));
        g += vec3(0.5, 0.38, 0.3) * sunSide * smoothstep(0.55, 1.0, rip) * exp(-depth * 18.0) * 0.12;
        if (above > 0.0) g = vec3(0.012, 0.018, 0.03);
        // little far lights along the shore
        float lx = q.x * 22.0;
        float lid = floor(lx);
        float on = step(0.82, hash12(vec2(lid, 2.0)));
        float lg = on * smoothstep(0.08, 0.0, length(vec2(fract(lx) - 0.5, (above - 0.004) * 22.0)));
        g += vec3(1.0, 0.8, 0.55) * lg * (0.6 + 0.4 * sin(uTime * 2.0 + lid));
        col = mix(col, g, uGround);
      }

      // floodlight beams converge on the vehicle
      if (uFlood > 0.001) {
        vec2 target = vec2(0.0, 7.0);
        float beams = 0.0;
        for (int i = 0; i < 4; i++) {
          float fi = float(i);
          vec2 src = vec2(fi < 2.0 ? -9.0 + fi * 4.2 : 6.2 + (fi - 2.0) * 4.6, -0.8);
          vec2 dir = normalize(target - src + vec2(0.0, 4.0 + fi));
          vec2 v = w - src;
          float along = max(dot(v, dir), 0.0);
          float perp = abs(v.x * dir.y - v.y * dir.x);
          float spread = 0.1 + along * 0.07;
          float b = step(0.001, dot(v, dir)) * exp(-perp / spread) * exp(-along * 0.05) / (1.0 + along * 0.08);
          b += exp(-length(v) * 3.5) * 2.0;
          beams += b;
        }
        col += vec3(0.5, 0.66, 0.92) * beams * 0.16 * uFlood;
      }

      // launch mount + apron (world space)
      float deck = max(abs(w.x) - 1.55, abs(w.y + 0.3) - 0.25);
      float trench = max(abs(w.x) - 0.62, abs(w.y + 0.36) - 0.18);
      float post = max(abs(abs(w.x) - 0.36) - 0.05, abs(w.y + 0.02) - 0.08);
      float mount = min(max(deck, -trench), post);
      float apron = w.y + 0.55;
      vec3 padCol = vec3(0.025, 0.03, 0.045);
      // fire light on the pad
      float fireD = length(w - uFirePos);
      vec3 fireCol = vec3(1.0, 0.45, 0.16) * uFire;
      padCol += fireCol * 0.55 * exp(-fireD * 0.55);
      float mountA = 1.0 - smoothstep(-pxW, pxW, mount);
      float apronA = 1.0 - smoothstep(-pxW, pxW, apron);
      vec3 apronCol = vec3(0.018, 0.022, 0.03) + fireCol * 0.45 * exp(-fireD * 0.35) + vec3(0.06, 0.08, 0.11) * uFlood * exp(-abs(w.x) * 0.15) * 0.4;
      col = mix(col, apronCol, apronA * uGround);
      // flame trench glows through the mount
      col = mix(col, padCol, mountA * uGround);
      // fire spilling from the flame trench: a soft glow, not a box
      vec2 tq = (w - vec2(0.0, -0.42)) / vec2(1.6, 0.35);
      col += vec3(1.0, 0.5, 0.2) * exp(-dot(tq, tq) * 2.2) * uFire * 0.9 * uGround;

      // tower
      float lightHit;
      float tower = towerMask(w, pxW, lightHit);
      if (tower > 0.0) {
        float h = w.y + 0.55;
        vec3 tc = vec3(0.012, 0.016, 0.026);
        tc += vec3(0.25, 0.35, 0.5) * 0.12 * uFlood;
        tc += vec3(1.0, 0.42, 0.14) * uFire * exp(-h * 0.42) * 0.7;
        tc += vec3(0.9, 0.55, 0.3) * 0.07 * sunSide;
        col = mix(col, tc, tower * uGround);
      }
      float blink = 0.55 + 0.45 * sin(uTime * 2.4);
      col += vec3(1.0, 0.85, 0.65) * lightHit * blink * uGround;

      // wet apron: floodlights mirror as soft vertical streaks
      if (w.y < -0.55) {
        float refl = 0.0;
        for (int i = 0; i < 4; i++) {
          float fi = float(i);
          float sx = fi < 2.0 ? -9.0 + fi * 4.2 : 6.2 + (fi - 2.0) * 4.6;
          refl += exp(-abs(w.x - sx) * 5.0) * exp((w.y + 0.55) * 0.9);
        }
        refl *= 0.6 + 0.4 * vnoise(vec2(w.x * 3.0, w.y * 24.0));
        col += vec3(0.45, 0.6, 0.85) * refl * 0.22 * uFlood * uGround;
      }

      // low ground fog, lit by the floods and — after ignition — by the fire
      float fy = w.y + 0.55;
      if (fy < 3.0) {
        float fogN = fbm3(vec2(w.x * 0.35 + uTime * 0.025, fy * 1.4 - uTime * 0.01));
        // feathered at its foot: a hard cut here drew a dark band across the apron
        float fog = exp(-max(fy, 0.0) / 0.8) * smoothstep(0.25, 0.75, fogN) * smoothstep(-2.4, -0.6, fy);
        vec3 fogC = vec3(0.32, 0.42, 0.58) * (0.35 + 0.65 * uFlood) + vec3(1.0, 0.45, 0.18) * uFire * exp(-length(w - uFirePos) * 0.25);
        col = mix(col, fogC, fog * 0.32 * uGround);
      }
    }

    // --- far cloud decks ---------------------------------------------------
    if (uCloudAmt > 0.001) {
      vec3 lit = mix(vec3(0.95, 0.93, 0.92), vec3(0.98, 0.98, 1.0), uSky);
      vec3 shade = mix(vec3(0.33, 0.43, 0.6), vec3(0.42, 0.56, 0.76), uSky);
      vec4 c1 = cloudDeck(q, uCloudY.x, 0.32, 1.1, 0.0, lit * 0.82, shade * 0.85);
      col = mix(col, c1.rgb, c1.a * uCloudAmt * 0.85);
      vec4 c2 = cloudDeck(q, uCloudY.y, 0.55, 0.75, 13.0, lit, shade);
      col = mix(col, c2.rgb, c2.a * uCloudAmt);
    }

    // --- Earth below: a flat horizon after the cloud deck, curving into a limb ----
    if (uEarth > 0.001) {
      vec2 ec = vec2(0.0, uEarthTop - uEarthR);
      vec2 rel = q - ec;
      float rlen = length(rel);
      float h = rlen - uEarthR;                       // > 0 above the limb
      float sunward = smoothstep(-1.1, 1.15, q.x / aspect);
      vec3 hazeDay = vec3(0.62, 0.8, 0.96);
      vec3 hazeNight = vec3(0.32, 0.58, 1.0);
      vec3 haze = mix(hazeDay, hazeNight, uNight);
      if (h < 0.0) {
        float d = -h;                                 // depth below the horizon
        // perspective: surface detail compresses toward the horizon
        float w = min(1.0 / (d * 6.0 + 0.05), 14.0);
        float along = atan(rel.x, rel.y) * uEarthR;   // arc length along the limb
        vec2 uvE = vec2(along * w * 0.55, w * 0.85 + uFlow * 0.015 + uTime * 0.006);
        float warpE = fbm3(uvE * 0.45 + 9.0);
        float cl = fbm(uvE + vec2(warpE * 1.4, 0.0));
        float cover = mix(0.44, 0.56, uNight);
        float cloudsE = smoothstep(cover, cover + 0.2, cl);
        float landE = smoothstep(0.55, 0.62, fbm3(uvE * 0.3 + 21.0));
        // daylight below the climb; a terminator once we reach orbit
        vec2 sp = rel / uEarthR;
        vec3 n = vec3(sp, sqrt(max(1.0 - dot(sp, sp), 0.0)));
        vec3 sunDir = normalize(vec3(0.78, 0.32, -0.25));
        float lamN = clamp(dot(n, sunDir) * 1.4 + 0.15, 0.0, 1.0);
        float lam = mix(0.7 + 0.3 * sunward, lamN, uNight);
        vec3 ocean = mix(vec3(0.004, 0.018, 0.05), mix(vec3(0.03, 0.11, 0.26), vec3(0.06, 0.2, 0.4), 1.0 - uNight), lam);
        vec3 landC = mix(vec3(0.006, 0.012, 0.016), vec3(0.08, 0.1, 0.12), lam);
        vec3 surf = mix(ocean, landC, landE * 0.7);
        vec3 cloudC = mix(vec3(0.42, 0.52, 0.68), vec3(0.95, 0.97, 1.0), clamp(lam + (cl - 0.6) * 1.5, 0.0, 1.0));
        surf = mix(surf, cloudC * (0.08 + 0.92 * lam), cloudsE * 0.9);
        float city = step(0.985, hash12(floor(uvE * 9.0))) * landE * (1.0 - lam) * (1.0 - cloudsE) * uNight;
        surf += vec3(1.0, 0.72, 0.45) * city * 0.22 * smoothstep(0.02, 0.12, d);
        // aerial perspective: distance dissolves into horizon haze
        float hz = exp(-d / mix(0.11, 0.035, uNight));
        surf = mix(surf, haze * mix(0.95, 0.3 + 0.7 * sunward, uNight), hz * mix(0.9, 0.6, uNight));
        float pxQ = 2.0 / uRes.y;
        col = mix(col, surf, smoothstep(pxQ, -pxQ, h) * uEarth);
      }
      // atmosphere above the horizon: broad haze by day, a thin bright line from orbit
      float ho = max(h, 0.0);
      float atmDay = exp(-ho / 0.09) * 0.55;
      float atmNight = exp(-ho / 0.0055) * 0.9 + exp(-ho / 0.03) * 0.35 + exp(-ho / 0.14) * 0.12;
      float atm = mix(atmDay, atmNight * (0.25 + 0.75 * sunward), uNight);
      vec3 atmC = mix(haze, vec3(0.78, 0.93, 1.0), exp(-ho / 0.012) * uNight);
      col += atmC * atm * uEarth * step(0.0, h + 0.004);

      // pre-dawn: the limb warms where the sun is about to break over it
      if (uDawn > 0.001) {
        vec2 dpos = ec + vec2(sin(uSunA), cos(uSunA)) * uEarthR;
        float dd = length(q - dpos);
        float onLimb = step(0.0, h + 0.004);
        col += vec3(1.0, 0.56, 0.3) * exp(-ho / 0.018) * exp(-dd * 2.0) * 0.9 * uDawn * onLimb;
        col += vec3(0.95, 0.52, 0.32) * exp(-ho / 0.14) * exp(-dd * 1.6) * 0.16 * uDawn;
      }

      // the sun, rising over the limb
      if (uSun > 0.001) {
        vec2 spos = ec + vec2(sin(uSunA), cos(uSunA)) * (uEarthR + 0.006);
        vec2 dd = q - spos;
        float dl = length(dd);
        float visible = smoothstep(-0.004, 0.012, h);
        vec3 warm = vec3(1.0, 0.72, 0.45);
        float core = exp(-dl * dl * 900.0) * visible;
        float glow = 0.05 / (0.05 + dl * dl * 30.0);
        float streak = exp(-abs(dd.y) * 90.0) * exp(-abs(dd.x) * 1.3);
        float rays = pow(max(0.0, sin(atan(dd.y, dd.x) * 9.0 + 0.4)), 30.0) * exp(-dl * 6.0) * 0.4;
        col += (vec3(1.0, 0.96, 0.9) * core * 3.0 + warm * glow * 0.75 + vec3(0.75, 0.88, 1.0) * streak * 0.55 + warm * rays) * uSun;
        col += warm * exp(-ho / 0.01) * exp(-dl * 4.0) * 0.8 * uSun;
      }
    }

    // --- exhaust trail -------------------------------------------------------
    if (uTrailAmt > 0.001) {
      vec2 v = q - uTrailA;
      float s = dot(v, uTrailDir);
      if (s > 0.0 && s < uTrailLen) {
        float r = v.x * uTrailDir.y - v.y * uTrailDir.x;
        float wdt = 0.028 + s * 0.085 + s * s * 0.02;
        vec2 tp = vec2(r / wdt * 0.9, s * 3.2 - uFlow * 0.8);
        float n = fbm(tp + vec2(0.0, uTime * 0.06));
        float edge = abs(r) / wdt + (n - 0.5) * 0.9;
        float d = smoothstep(1.0, 0.25, edge) * smoothstep(0.0, 0.06, s) * smoothstep(uTrailLen, uTrailLen * 0.55, s);
        float side = clamp(0.5 + r / wdt * 0.5, 0.0, 1.0);
        vec3 tl = mix(vec3(0.42, 0.5, 0.62), vec3(0.94, 0.92, 0.9), side * 0.7 + n * 0.3);
        // sunlit, high-altitude exhaust turns luminous blue
        tl = mix(tl, mix(vec3(0.3, 0.55, 0.95), vec3(0.82, 0.93, 1.0), side), uTrailLit);
        col = mix(col, tl, d * uTrailAmt * mix(0.85, 0.5, uTrailLit));
      }
    }

    // gentle dither kills banding in the deep gradients
    col += (hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`

/** Foreground: near cloud deck (passes in front of the vehicle) and ignition flashes. */
export const FG_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uRes;
  uniform float uTime;
  uniform float uCloudY;
  uniform float uCloudAmt;
  uniform float uFlow;
  uniform float uFlash;
  uniform vec3 uFlashCol;
  uniform vec4 uClear;   // keep the copy legible: axis (0 = x, 1 = y), edge0, edge1, invert
  uniform vec2 uFirePos;
  uniform float uFire;
  uniform vec3 uRing;    // shock ring: radius, width, intensity

  ${NOISE}

  void main() {
    float aspect = uRes.x / uRes.y;
    vec2 q = (vUv - 0.5) * vec2(aspect, 1.0) * 2.0;
    vec3 col = vec3(0.0);
    float alpha = 0.0;

    if (uCloudAmt > 0.001) {
      float dy = (q.y - uCloudY) / 0.75;
      float env = exp(-dy * dy * 1.6);
      if (env > 0.02) {
        vec2 cp = vec2(q.x * 0.62 + uTime * 0.02, (q.y - uCloudY) * 0.9 + uFlow * 0.22);
        vec2 warp = vec2(fbm3(cp * 0.7 + 1.3), fbm3(cp * 0.7 + 5.9));
        vec2 bp = cp + warp * 1.5;
        float n = fbm(bp);
        float n2 = fbm(bp + vec2(0.12, 0.2));
        // closest to the lens: eroded like the far decks, a touch softer (depth of field)
        float detail = fbm3(bp * 2.8 + 3.0);
        float dens = smoothstep(0.47, 0.565, n * (0.5 + 0.65 * env) - (detail - 0.5) * 0.14);
        // keep the copy column and the HUD bands readable
        float v = uClear.x < 0.5 ? q.x / aspect : q.y;
        float zone = smoothstep(uClear.y, uClear.z, v);
        dens *= 1.0 - 0.9 * mix(zone, 1.0 - zone, uClear.w);
        dens *= smoothstep(1.02, 0.7, q.y) * smoothstep(-1.02, -0.62, q.y);
        float light = clamp((n - n2) * 7.0 + 0.66 + (detail - 0.5) * 0.5, 0.0, 1.0);
        vec3 c = mix(vec3(0.46, 0.58, 0.76), vec3(1.0, 0.99, 0.98), light);
        // engine light glows inside the cloud near the plume
        float fd = length(q - uFirePos);
        c += vec3(1.0, 0.5, 0.2) * uFire * exp(-fd * 2.2) * 0.9;
        col = c;
        alpha = dens * env * uCloudAmt;
      }
    }

    if (uFlash > 0.001) {
      float fd = length(q - uFirePos);
      float v = exp(-fd * 0.9);
      // hot pinpoint + soft bloom + a faint anamorphic streak
      float core = exp(-fd * fd * 60.0);
      float streak = exp(-abs(q.y - uFirePos.y) * 70.0) * exp(-abs(q.x - uFirePos.x) * 1.6);
      col += uFlashCol * uFlash * (0.35 + v + core * 2.5) + vec3(0.7, 0.85, 1.0) * streak * uFlash * 0.9;
      alpha = max(alpha, clamp(uFlash * (0.25 + v * 0.75 + core + streak), 0.0, 1.0));
    }

    if (uRing.z > 0.002) {
      vec2 rq = q - uFirePos;
      rq.y *= 1.12;                                  // a touch of perspective
      float rd = (length(rq) - uRing.x) / uRing.y;
      float ring = exp(-rd * rd) * uRing.z;
      // the ring is brighter on its leading (outer) edge
      ring *= 0.6 + 0.4 * smoothstep(-1.0, 1.0, rd);
      col += vec3(0.82, 0.92, 1.0) * ring * 1.8;
      alpha = max(alpha, clamp(ring, 0.0, 1.0));
    }

    gl_FragColor = vec4(col, alpha);
  }
`

/** Engine plume (additive). Quad hangs below the nozzle; uv.y = 1 at the nozzle. */
export const PLUME_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const PLUME_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uPower;
  uniform float uVac;
  uniform float uDiamonds;
  uniform float uNozzle;
  uniform vec2 uSize;
  uniform float uSeed;
  uniform float uCool;
  uniform float uShell;
  uniform float uClip;

  ${NOISE}

  void main() {
    float S = (1.0 - vUv.y) * uSize.y;          // distance from nozzle, world units
    float X = (vUv.x - 0.5) * uSize.x;          // lateral offset, world units
    float t = uTime;
    float P = uPower;

    // plume radius: a tight column at sea level, a wide bulb in vacuum
    float rSea = uNozzle * (0.92 + 0.07 * S) + 0.012 * S * S;
    float rVac = uNozzle * 0.9 + 0.62 * sqrt(S) + 0.08 * S;
    float rS = mix(rSea, rVac, uVac);
    float rr = abs(X) / rS;

    float n = fbm(vec2(X / rS * 1.3, S * 1.25 - t * 9.0) + uSeed);
    float n2 = vnoise(vec2(X * 5.0, S * 3.5 - t * 22.0) + uSeed * 3.0);

    float lenScale = mix(1.0, 0.75, uVac) * (0.25 + 0.75 * P);
    float fadeL = exp(-S / (4.6 * lenScale));
    float edge = rr + (n - 0.5) * mix(0.7, 0.9, uVac) * smoothstep(0.0, 1.5, S);
    float body = smoothstep(1.0, 0.1, edge);

    float coreLen = mix(1.9, 0.9, uVac) * (0.4 + 0.6 * P);
    float core = exp(-rr * rr * 6.0) * smoothstep(coreLen * 1.25, 0.0, S);

    // shock diamonds — bright nodes in the supersonic core at low altitude
    float lambda = 0.62;
    float ph = fract(S / lambda - 0.35);
    float pd = (ph - 0.5) / 0.16;
    float dia = exp(-pd * pd) * exp(-rr * rr * 16.0) * smoothstep(4.2, 0.6, S) * uDiamonds;

    // uCool → 1: a vacuum flame — warm-white at the throat, ice-blue beyond (never pink)
    vec3 cWhite = vec3(1.0, 0.97, 0.9);
    vec3 cYellow = mix(vec3(1.0, 0.76, 0.4), vec3(1.0, 0.86, 0.68), uCool);
    vec3 cOrange = mix(vec3(1.0, 0.4, 0.14), vec3(0.26, 0.44, 1.0), uCool);

    float flick = 0.88 + 0.12 * sin(t * 53.0 + uSeed) * sin(t * 37.0 + uSeed * 2.0);
    vec3 col = vec3(0.0);
    col += cOrange * body * fadeL * (0.45 + 0.55 * n2) * mix(1.05, 0.5, uVac);
    col += cYellow * body * exp(-S / (1.8 * lenScale)) * exp(-rr * rr * 1.6) * mix(1.05, 0.4, uVac);
    col += cWhite * core * mix(2.0, 1.1, uVac);
    col += cWhite * dia * 1.5;
    col *= P * flick;

    // on the pad the exhaust hits the deck and splashes sideways into the trench
    float hit = S - uClip;
    col *= smoothstep(0.35, -0.3, hit);
    col += mix(cOrange, cYellow, 0.4) * exp(-hit * hit / 0.06) * exp(-abs(X) * 0.9) * P * 1.3;

    // sunlit vacuum exhaust shell ("jellyfish"): a crisp luminous bell with
    // faint streamers inside — atmospheric blue against black space
    if (uShell > 0.001) {
      float rs = 0.3 + 1.0 * sqrt(S) + 0.06 * S;            // bell radius
      float ax = abs(X) / rs;                                // 0 on the axis, 1 on the shell
      float sd = (ax - 1.0) * rs / (0.07 + 0.05 * S);        // distance to the shell, in shell widths
      float shell = exp(-sd * sd);
      float sn = fbm3(vec2(X * 0.8 + uSeed, S * 0.6 - t * 0.35) + 7.0);
      float streamers = 0.4 + 0.6 * vnoise(vec2(X / rs * 7.0 + uSeed, S * 0.4 - t * 0.5));
      float fill = smoothstep(1.02, 0.15, ax) * 0.2 * streamers;
      float a = (shell * (0.65 + 0.5 * sn) + fill) * smoothstep(0.15, 1.3, S) * exp(-S / 4.4);
      vec3 sc = mix(vec3(0.16, 0.38, 1.0), vec3(0.8, 0.93, 1.0), shell * 0.85);
      col += sc * a * uShell * 0.62;
    }

    // fade to nothing at the quad's sides and far end — no visible edges
    float win = smoothstep(1.0, 0.72, abs(vUv.x * 2.0 - 1.0)) * smoothstep(0.0, 0.25, vUv.y);
    gl_FragColor = vec4(col * win, 1.0);
  }
`

/** Soft additive glow sprite (camera-facing quad in the rocket plane). */
export const GLOW_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uAlpha;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = exp(-d * d * 4.5) * 0.85 + exp(-d * 9.0) * 0.6;
    a *= smoothstep(1.0, 0.85, d);
    gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
  }
`

/** Vapor cone at Max-Q — a translucent collar flaring back from the fairing shoulder. */
export const VAPOR_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uAmt;
  uniform vec2 uSize;
  ${NOISE}
  void main() {
    float S = (1.0 - vUv.y) * uSize.y;      // downward from the shoulder
    float X = (vUv.x - 0.5) * uSize.x;
    float r = 0.5 + S * 0.62;                 // cone half-width
    float u = X / r;                          // −1…1 across the cone
    if (abs(u) > 1.25) discard;
    // streaky condensation flowing back along the cone
    float n = fbm(vec2(u * 2.6, S * 1.1 - uTime * 2.6));
    float streak = fbm(vec2(u * 9.0, S * 0.35 - uTime * 1.2));
    float limb = smoothstep(0.6, 1.0, abs(u)) * smoothstep(1.2, 0.98, abs(u));
    float fill = smoothstep(1.06, 0.7, abs(u)) * 0.55;
    float collar = exp(-S * 5.0) * smoothstep(1.15, 0.5, abs(u)) * 0.7;
    float body = (limb * 0.85 + fill + collar) * (0.45 + 0.75 * n) * (0.65 + 0.5 * streak);
    float len = smoothstep(0.0, 0.12, S) * smoothstep(1.7, 0.35, S + (n - 0.5) * 0.5);
    float shade = 0.82 + 0.18 * smoothstep(-1.0, 1.0, u);
    gl_FragColor = vec4(vec3(0.95, 0.97, 1.0) * shade, body * len * uAmt);
  }
`

/** Billboard smoke / steam puffs (instanced). */
export const SMOKE_VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec4 iData; // size, alpha, seed, heat
  varying vec2 vUv;
  varying vec4 vData;
  void main() {
    vUv = uv;
    vData = iData;
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    mv.xy += position.xy * iData.x;
    gl_Position = projectionMatrix * mv;
  }
`

export const SMOKE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec4 vData;
  uniform float uTime;
  uniform vec3 uLit;
  uniform vec3 uShade;
  uniform vec3 uHeat;
  uniform vec2 uLightDir;
  ${NOISE}
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0 || vData.y < 0.002) discard;
    float seed = vData.z;
    float c = cos(seed * 6.28);
    float s = sin(seed * 6.28);
    vec2 pr = mat2(c, -s, s, c) * p;
    float n = fbm3(pr * 1.7 + seed * 17.0 + vec2(0.0, uTime * 0.04));
    float m = smoothstep(1.0, 0.3, r + (n - 0.5) * 0.7);
    vec3 nrm = vec3(p, sqrt(max(0.0, 1.0 - r * r)));
    float lit = clamp(dot(nrm, normalize(vec3(uLightDir, 0.55))) * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uShade, uLit, clamp(lit * 0.85 + (n - 0.5) * 0.6, 0.0, 1.0));
    col += uHeat * vData.w * (0.55 + 0.45 * (1.0 - p.y)) * (0.6 + 0.4 * n);
    gl_FragColor = vec4(col, m * vData.y);
  }
`

/** "Network of light" payload — glowing nodes. */
export const NODE_VERT = /* glsl */ `
  attribute vec3 aDir;
  attribute float aRand;
  uniform float uTime;
  uniform float uUnfold;
  uniform float uScale;
  uniform float uPx;
  varying float vA;
  void main() {
    // unfolds into a calm geodesic shell (slight jitter keeps it organic)
    float radius = uScale * mix(1.0, 3.9 + 0.5 * (aRand - 0.5), uUnfold);
    vec3 p = aDir * radius * (1.0 + 0.03 * sin(uTime * 1.3 + aRand * 20.0));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPx * (0.55 + aRand * 0.9) * (1.0 + uUnfold * 0.5);
    vA = 0.55 + 0.45 * sin(uTime * 2.0 + aRand * 31.0);
  }
`

export const NODE_FRAG = /* glsl */ `
  precision highp float;
  varying float vA;
  uniform vec3 uColor;
  uniform float uAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = exp(-d * d * 5.0) + 0.6 * smoothstep(0.35, 0.0, d);
    gl_FragColor = vec4(uColor * a * vA * uAlpha, 1.0);
  }
`

export const EDGE_VERT = /* glsl */ `
  attribute vec3 aDir;
  attribute float aRand;
  attribute float aT;
  attribute float aPhase;
  uniform float uTime;
  uniform float uUnfold;
  uniform float uScale;
  varying float vT;
  varying float vPhase;
  void main() {
    float radius = uScale * mix(1.0, 3.9 + 0.5 * (aRand - 0.5), uUnfold);
    vec3 p = aDir * radius * (1.0 + 0.03 * sin(uTime * 1.3 + aRand * 20.0));
    vT = aT;
    vPhase = aPhase;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

export const EDGE_FRAG = /* glsl */ `
  precision highp float;
  varying float vT;
  varying float vPhase;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uAlpha;
  void main() {
    float travel = fract(uTime * 0.28 + vPhase);
    float pulse = smoothstep(0.1, 0.0, abs(travel - vT)) * step(0.55, fract(vPhase * 7.31));
    float a = 0.16 + pulse * 0.9;
    gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
  }
`

/** Orbit traces around the payload: faint ellipses with a bright travelling head. */
export const RING_VERT = /* glsl */ `
  attribute float aT;
  varying float vT;
  void main() {
    vT = aT;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const RING_FRAG = /* glsl */ `
  precision highp float;
  varying float vT;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uPhase;
  uniform vec3 uColor;
  uniform float uAlpha;
  void main() {
    float head = fract(vT - uTime * uSpeed - uPhase);
    float tail = pow(head, 10.0);
    float a = 0.12 + tail * 0.95;
    gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
  }
`
