/* RuralPulse hero: a procedural rural valley at monsoon dusk.
 * Paddy and mustard fields, a river, villages with lit windows, and pulses of
 * light travelling along care routes to the district hospital beacon.
 * Scales by device (quality tiers), pauses off-screen, honours reduced motion
 * and the low-bandwidth switch, and falls back to a static poster without WebGL. */
(function () {
  "use strict";
  const hero = document.querySelector(".hero");
  const canvas = document.getElementById("scene");
  const toggle = document.getElementById("motionToggle");
  if (!hero || !canvas) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lowbw = () => document.body.classList.contains("lowbw");
  function fail() { hero.classList.add("no-webgl"); toggle.hidden = true; }
  if (!window.THREE || lowbw()) { if (!window.THREE) fail(); else toggle.hidden = true; }
  if (!window.THREE) return;
  const T = window.THREE;

  // ---------------------------------------------------------------- quality tier
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const cores = navigator.hardwareConcurrency || 4;
  const tier = small || coarse ? "low" : cores >= 8 && window.devicePixelRatio <= 2 ? "high" : "mid";
  const Q = {
    low: { seg: 110, trees: 260, houses: 70, dpr: 1.25, shadows: false, bloom: false, flies: 120 },
    mid: { seg: 170, trees: 520, houses: 120, dpr: 1.5, shadows: true, bloom: true, flies: 220 },
    high: { seg: 230, trees: 820, houses: 160, dpr: 2, shadows: true, bloom: true, flies: 320 },
  }[tier];

  let renderer;
  try {
    renderer = new T.WebGLRenderer({ canvas, antialias: tier !== "low", powerPreference: "high-performance" });
  } catch (e) { fail(); return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q.dpr));
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = Q.shadows;
  renderer.shadowMap.type = T.PCFSoftShadowMap;

  const scene = new T.Scene();
  const FOG = new T.Color("#22363a");
  scene.fog = new T.FogExp2(FOG, 0.0036);
  const camera = new T.PerspectiveCamera(40, 1, 0.5, 1600);

  // ---------------------------------------------------------------- noise
  function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, o = 5) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < o; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; } return s; }

  // river path and terrain height
  const riverZ = (x) => 38 * Math.sin(x / 70) + 14 * Math.sin(x / 23 + 1.3) + 10;
  function height(x, z) {
    const r = Math.hypot(x, z);
    const valley = T.MathUtils.smoothstep(r, 120, 260);
    let h = (fbm(x * 0.012, z * 0.012) - 0.5) * 3 + valley * (18 + fbm(x * 0.006 + 9, z * 0.006 + 4) * 70);
    const dr = Math.abs(z - riverZ(x));
    const carve = 1 - T.MathUtils.smoothstep(dr, 3, 11);
    h -= carve * 3.2 * (1 - valley);
    return h;
  }

  // ---------------------------------------------------------------- sky dome
  const sunDir = new T.Vector3(0.62, 0.07, -0.78).normalize();
  const skyMat = new T.ShaderMaterial({
    side: T.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new T.Color("#06161c") }, mid: { value: new T.Color("#1d3a42") }, horizon: { value: new T.Color("#d9894a") }, sun: { value: sunDir } },
    vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 sun; varying vec3 vP;
      void main(){ float h = max(vP.y, 0.0);
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.18, h)); c = mix(c, top, smoothstep(0.15, 0.7, h));
        float s = max(dot(normalize(vP), sun), 0.0);
        c += vec3(1.0,0.55,0.25) * pow(s, 10.0) * 0.55 + vec3(1.0,0.78,0.45) * pow(s, 600.0) * 1.6;
        c = mix(c, horizon * 0.55, smoothstep(0.0, -0.08, vP.y));
        gl_FragColor = vec4(c, 1.0); }`,
  });
  scene.add(new T.Mesh(new T.SphereGeometry(900, 32, 16), skyMat));
  {
    const n = 900, g = new T.BufferGeometry(), p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(1 - Math.random() * 0.75);
      p.set([850 * Math.sin(ph) * Math.cos(th), 850 * Math.cos(ph), 850 * Math.sin(ph) * Math.sin(th)], i * 3);
    }
    g.setAttribute("position", new T.BufferAttribute(p, 3));
    scene.add(new T.Points(g, new T.PointsMaterial({ color: 0xcfe3ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.55, fog: false })));
  }

  // ---------------------------------------------------------------- lights
  scene.add(new T.HemisphereLight(0x6f97a6, 0x2b2218, 0.42));
  const sun = new T.DirectionalLight(0xff9f55, 1.55);
  sun.position.copy(sunDir).multiplyScalar(300);
  sun.castShadow = Q.shadows;
  if (Q.shadows) {
    sun.shadow.mapSize.set(tier === "high" ? 2048 : 1024, tier === "high" ? 2048 : 1024);
    Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 170, bottom: -170, near: 50, far: 700 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.8;
  }
  scene.add(sun);

  // ---------------------------------------------------------------- terrain
  const SIZE = 640;
  const tg = new T.PlaneGeometry(SIZE, SIZE, Q.seg, Q.seg);
  tg.rotateX(-Math.PI / 2);
  const pos = tg.attributes.position, col = new Float32Array(pos.count * 3);
  const PAL = [new T.Color("#4f7d36"), new T.Color("#6e9a3c"), new T.Color("#c9a53a"), new T.Color("#83a646"), new T.Color("#7a6340"), new T.Color("#3f6b33")];
  const bank = new T.Color("#6b5a40"), hill = new T.Color("#2f4a2c"), rock = new T.Color("#5a5446"), tmp = new T.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = height(x, z);
    pos.setY(i, h);
    const r = Math.hypot(x, z), valley = T.MathUtils.smoothstep(r, 110, 220);
    const wx = x + (fbm(x * 0.03, z * 0.03, 2) - 0.5) * 8, wz = z + (fbm(z * 0.03, x * 0.03, 2) - 0.5) * 8;
    const cx = Math.floor(wx / 15), cz = Math.floor(wz / 11);
    tmp.copy(PAL[Math.floor(hash(cx, cz) * PAL.length)]);
    const fx = wx / 15 - cx, fz = wz / 11 - cz;
    if (fx < 0.06 || fz < 0.08) tmp.multiplyScalar(0.62); // field bunds
    tmp.multiplyScalar(0.85 + fbm(x * 0.2, z * 0.2, 2) * 0.3);
    tmp.lerp(hill, valley);
    if (h > 45) tmp.lerp(rock, T.MathUtils.smoothstep(h, 45, 80));
    const dr = Math.abs(z - riverZ(x));
    tmp.lerp(bank, (1 - T.MathUtils.smoothstep(dr, 4, 9)) * (1 - valley));
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  tg.setAttribute("color", new T.BufferAttribute(col, 3));
  tg.computeVertexNormals();
  const terrain = new T.Mesh(tg, new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
  terrain.receiveShadow = true;
  scene.add(terrain);

  // river water
  const wg = new T.PlaneGeometry(SIZE, SIZE, 1, 1); wg.rotateX(-Math.PI / 2);
  const water = new T.Mesh(wg, new T.MeshStandardMaterial({ color: 0x2f5c66, roughness: 0.12, metalness: 0.55, transparent: true, opacity: 0.92 }));
  water.position.y = -1.2; scene.add(water);

  // ---------------------------------------------------------------- villages, hub
  const villages = [[-30, -18], [42, 46], [78, -26], [-78, 52], [12, -78], [-112, -40]].filter(([x, z]) => Math.abs(z - riverZ(x)) > 14);
  const hub = new T.Vector3(-46, 0, -128); hub.y = height(hub.x, hub.z);

  const wallG = new T.BoxGeometry(1, 1, 1); wallG.translate(0, 0.5, 0);
  const roofG = new T.ConeGeometry(0.82, 0.7, 4); roofG.rotateY(Math.PI / 4); roofG.translate(0, 1.35, 0);
  const winG = new T.PlaneGeometry(0.28, 0.32);
  const walls = new T.InstancedMesh(wallG, new T.MeshStandardMaterial({ color: 0xd8c4a2, roughness: 0.9 }), Q.houses);
  const roofs = new T.InstancedMesh(roofG, new T.MeshStandardMaterial({ color: 0x8c4a32, roughness: 0.8 }), Q.houses);
  const wins = new T.InstancedMesh(winG, new T.MeshBasicMaterial({ color: 0xffc36b, toneMapped: false }), Q.houses);
  walls.castShadow = roofs.castShadow = Q.shadows; walls.receiveShadow = true;
  const m4 = new T.Matrix4(), q = new T.Quaternion(), s3 = new T.Vector3(), p3 = new T.Vector3(), e3 = new T.Euler();
  for (let i = 0; i < Q.houses; i++) {
    const [vx, vz] = villages[i % villages.length];
    const a = hash(i, 3) * Math.PI * 2, d = 2 + hash(i, 7) * 11;
    const x = vx + Math.cos(a) * d, z = vz + Math.sin(a) * d, y = height(x, z);
    const w = 2.2 + hash(i, 9) * 1.8, hgt = 1.6 + hash(i, 11) * 1.2;
    e3.set(0, hash(i, 13) * Math.PI, 0); q.setFromEuler(e3);
    m4.compose(p3.set(x, y - 0.1, z), q, s3.set(w, hgt, w * 0.8)); walls.setMatrixAt(i, m4); roofs.setMatrixAt(i, m4);
    const off = new T.Vector3(0, 0.55 * hgt, w * 0.41).applyQuaternion(q);
    m4.compose(p3.set(x + off.x, y + off.y, z + off.z), q, s3.set(hash(i, 17) > 0.35 ? 1.4 : 0.001, 1.4, 1)); wins.setMatrixAt(i, m4);
  }
  scene.add(walls, roofs, wins);

  // district hospital + marigold beacon
  const hospital = new T.Group();
  const bodyM = new T.MeshStandardMaterial({ color: 0xe8ece6, roughness: 0.6 });
  const main = new T.Mesh(new T.BoxGeometry(18, 7, 10), bodyM); main.position.y = 3.5;
  const wing = new T.Mesh(new T.BoxGeometry(8, 5, 16), bodyM); wing.position.set(-11, 2.5, 3);
  [main, wing].forEach((m) => { m.castShadow = Q.shadows; m.receiveShadow = true; hospital.add(m); });
  const stripG = new T.PlaneGeometry(16, 0.6), stripM = new T.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false });
  [2.2, 4.4].forEach((y) => { const s = new T.Mesh(stripG, stripM); s.position.set(0, y, 5.02); hospital.add(s); });
  hospital.position.copy(hub); hospital.lookAt(0, hub.y, 0); scene.add(hospital);
  const beamM = new T.MeshBasicMaterial({ color: 0xf4b23e, transparent: true, opacity: 0.28, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false });
  const beam = new T.Mesh(new T.CylinderGeometry(0.9, 2.6, 120, 24, 1, true), beamM); beam.position.set(hub.x, hub.y + 60, hub.z); scene.add(beam);
  const core = new T.Mesh(new T.SphereGeometry(1.6, 24, 16), new T.MeshBasicMaterial({ color: 0xffd27a, toneMapped: false })); core.position.set(hub.x, hub.y + 9, hub.z); scene.add(core);
  const hubLight = new T.PointLight(0xffb84a, 2.2, 90, 2); hubLight.position.copy(core.position); scene.add(hubLight);
  const rings = [0, 1, 2].map((i) => {
    const r = new T.Mesh(new T.RingGeometry(0.96, 1, 96), new T.MeshBasicMaterial({ color: 0xf4b23e, transparent: true, opacity: 0, side: T.DoubleSide, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    r.rotation.x = -Math.PI / 2; r.position.set(hub.x, hub.y + 0.6, hub.z); r.userData.phase = i / 3; scene.add(r); return r;
  });

  // ---------------------------------------------------------------- trees
  const trunkG = new T.CylinderGeometry(0.18, 0.28, 2.2, 5); trunkG.translate(0, 1.1, 0);
  const crownG = new T.IcosahedronGeometry(1.5, 1); crownG.translate(0, 3.1, 0);
  const trunks = new T.InstancedMesh(trunkG, new T.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 }), Q.trees);
  const crowns = new T.InstancedMesh(crownG, new T.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), Q.trees);
  crowns.castShadow = trunks.castShadow = Q.shadows;
  const greens = ["#2f5a2a", "#3d6b2f", "#46753a", "#2a4a26", "#55803c"].map((c) => new T.Color(c));
  let placed = 0, tries = 0;
  while (placed < Q.trees && tries < Q.trees * 12) {
    tries++;
    const x = (hash(tries, 1) - 0.5) * 440, z = (hash(tries, 2) - 0.5) * 440;
    const r = Math.hypot(x, z), dr = Math.abs(z - riverZ(x));
    const nearRiver = dr > 6 && dr < 16, onBund = vnoise(x / 15, z / 11) > 0.78, edge = r > 150;
    if (!(nearRiver || onBund || (edge && hash(tries, 5) > 0.35))) continue;
    if (villages.some(([vx, vz]) => Math.hypot(x - vx, z - vz) < 13) || Math.hypot(x - hub.x, z - hub.z) < 22) continue;
    const y = height(x, z), sc = 0.7 + hash(tries, 3) * 1.1;
    e3.set(0, hash(tries, 4) * 6, 0); q.setFromEuler(e3);
    m4.compose(p3.set(x, y - 0.2, z), q, s3.set(sc, sc * (0.9 + hash(tries, 6) * 0.5), sc));
    trunks.setMatrixAt(placed, m4); crowns.setMatrixAt(placed, m4);
    crowns.setColorAt(placed, greens[Math.floor(hash(tries, 8) * greens.length)]);
    placed++;
  }
  trunks.count = crowns.count = placed;
  scene.add(trunks, crowns);

  // ---------------------------------------------------------------- care routes + pulses
  const routes = [], pulses = [];
  const routeM = new T.MeshBasicMaterial({ color: 0xf4b23e, transparent: true, opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false });
  const pulseG = new T.SphereGeometry(0.75, 12, 8);
  villages.forEach(([vx, vz], i) => {
    const a = new T.Vector3(vx, height(vx, vz) + 3, vz), b = core.position.clone();
    const mid = a.clone().lerp(b, 0.5); mid.y += 22 + a.distanceTo(b) * 0.12;
    const curve = new T.QuadraticBezierCurve3(a, mid, b);
    routes.push(curve);
    scene.add(new T.Mesh(new T.TubeGeometry(curve, 64, 0.14, 6, false), routeM));
    for (let k = 0; k < 2; k++) {
      const pm = new T.Mesh(pulseG, new T.MeshBasicMaterial({ color: 0xffe0a0, toneMapped: false, transparent: true }));
      pm.userData = { curve, t: (i * 0.17 + k * 0.5) % 1, speed: 0.07 + hash(i, k) * 0.05 };
      scene.add(pm); pulses.push(pm);
    }
    const halo = new T.Mesh(new T.RingGeometry(9, 9.4, 64), new T.MeshBasicMaterial({ color: 0xf4b23e, transparent: true, opacity: 0.18, side: T.DoubleSide, toneMapped: false, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2; halo.position.set(vx, height(vx, vz) + 0.4, vz); scene.add(halo);
  });

  // fireflies
  const fg = new T.BufferGeometry(), fp = new Float32Array(Q.flies * 3), fseed = new Float32Array(Q.flies);
  for (let i = 0; i < Q.flies; i++) {
    const x = (Math.random() - 0.5) * 260, z = (Math.random() - 0.5) * 220;
    fp.set([x, height(x, z) + 1 + Math.random() * 5, z], i * 3); fseed[i] = Math.random() * 100;
  }
  fg.setAttribute("position", new T.BufferAttribute(fp, 3));
  const flies = new T.Points(fg, new T.PointsMaterial({ color: 0xffd27a, size: 0.55, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
  scene.add(flies);
  const fbase = fp.slice();

  // ---------------------------------------------------------------- post-processing
  let composer = null;
  if (Q.bloom && T.EffectComposer && T.UnrealBloomPass) {
    composer = new T.EffectComposer(renderer);
    composer.addPass(new T.RenderPass(scene, camera));
    composer.addPass(new T.UnrealBloomPass(new T.Vector2(1, 1), 0.75, 0.6, 0.88));
  }

  // ---------------------------------------------------------------- camera rig
  const look = new T.Vector3(-20, 6, -60);
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  window.addEventListener("pointermove", (e) => { mouse.tx = e.clientX / window.innerWidth - 0.5; mouse.ty = e.clientY / window.innerHeight - 0.5; }, { passive: true });
  function resize() {
    const w = hero.clientWidth, h = hero.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.8 ? 58 : 40;
    // On wide screens, pan the frame so the hospital and routes sit to the right of the headline.
    if (w / h > 1.1) camera.setViewOffset(w, h, -w * 0.2, 0, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
  }
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 120); });
  resize();

  // ---------------------------------------------------------------- loop
  const clock = new T.Clock();
  let running = !reduced, visible = true, elapsed = 8;
  function frame(dt) {
    elapsed += dt;
    const scroll = Math.min(1, window.scrollY / Math.max(1, hero.clientHeight));
    mouse.x += (mouse.tx - mouse.x) * 0.04; mouse.y += (mouse.ty - mouse.y) * 0.04;
    const ang = elapsed * 0.018 + 0.6;
    const rad = 175 - scroll * 45;
    camera.position.set(Math.cos(ang) * rad + mouse.x * 18, 58 - scroll * 22 - mouse.y * 8, Math.sin(ang) * rad * 0.55 + 120);
    camera.lookAt(look.x + mouse.x * 10, look.y, look.z);

    pulses.forEach((p) => {
      p.userData.t = (p.userData.t + dt * p.userData.speed) % 1;
      p.position.copy(p.userData.curve.getPoint(p.userData.t));
      const fade = Math.sin(p.userData.t * Math.PI);
      p.scale.setScalar(0.6 + fade * 0.8); p.material.opacity = 0.35 + fade * 0.65;
    });
    rings.forEach((r) => {
      const k = (elapsed * 0.32 + r.userData.phase) % 1;
      r.scale.setScalar(4 + k * 70); r.material.opacity = (1 - k) * 0.55;
    });
    const beat = Math.pow(Math.max(0, Math.sin(elapsed * 2.2)), 8);
    core.scale.setScalar(1 + beat * 0.6); hubLight.intensity = 1.8 + beat * 2.4; beamM.opacity = 0.2 + beat * 0.2;
    const fpos = fg.attributes.position;
    for (let i = 0; i < Q.flies; i++) {
      const s = fseed[i];
      fpos.setXYZ(i, fbase[i * 3] + Math.sin(elapsed * 0.5 + s) * 2, fbase[i * 3 + 1] + Math.sin(elapsed * 0.9 + s * 2) * 0.8, fbase[i * 3 + 2] + Math.cos(elapsed * 0.4 + s) * 2);
    }
    fpos.needsUpdate = true;
    flies.material.opacity = 0.55 + Math.sin(elapsed * 3) * 0.25;
    water.material.color.setHSL(0.53, 0.35, 0.27 + Math.sin(elapsed * 0.6) * 0.012);
    composer ? composer.render() : renderer.render(scene, camera);
  }
  function loop() {
    if (!running || !visible || lowbw()) { clock.stop(); return; }
    if (!clock.running) clock.start();
    frame(Math.min(clock.getDelta(), 0.05));
    requestAnimationFrame(loop);
  }
  function start() { if (running && visible && !lowbw()) { clock.start(); requestAnimationFrame(loop); } }

  frame(0); // first still frame (also the reduced-motion view)
  hero.classList.add("ready");
  if (reduced) { toggle.textContent = "Play animation"; toggle.setAttribute("aria-pressed", "true"); }
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) start(); }, { threshold: 0.02 }).observe(hero);
  document.addEventListener("visibilitychange", () => { visible = !document.hidden; if (visible) start(); });
  toggle.addEventListener("click", () => {
    running = !running;
    toggle.textContent = running ? "Pause animation" : "Play animation";
    toggle.setAttribute("aria-pressed", String(!running));
    if (running) start();
  });
  window.addEventListener("rp:lowbw", (e) => {
    if (e.detail) { hero.classList.remove("ready"); toggle.hidden = true; }
    else { hero.classList.add("ready"); toggle.hidden = false; frame(0); start(); }
  });
  start();
})();
