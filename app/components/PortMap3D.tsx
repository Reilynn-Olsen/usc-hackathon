"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { SHIPS, type Ship, type ScenarioId } from "../lib/data";
import { Icon } from "../lib/icons";

export type MapCommand = { kind: "reset" | "zoomIn" | "zoomOut" | "focusShip" | "focusPort"; shipId?: string; nonce: number };
type WeatherArea = { x: number; z: number; radius: number; color: string };
type Props = {
  selectedShip: string;
  onSelectShip: (id: string) => void;
  weather: WeatherArea;
  simulated?: boolean;
  scenarioId?: ScenarioId;
  command?: MapCommand;
  compact?: boolean;
};

type MapApi = {
  command: (command: MapCommand) => void;
  setWeather: (weather: WeatherArea, simulated: boolean) => void;
  setSelected: (shipId: string) => void;
  destroy: () => void;
};

const CDNS = [
  "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js",
  "https://unpkg.com/three@0.180.0/build/three.module.js",
];

async function getThree(): Promise<any> {
  // The browser imports Three.js directly so this drop-in only changes /app.
  // To bundle locally later: npm install three, then replace this with import("three").
  const browserImport = new Function("url", "return import(url)") as (url: string) => Promise<any>;
  let lastError: unknown;
  for (const url of CDNS) {
    try { return await browserImport(url); } catch (error) { lastError = error; }
  }
  throw lastError;
}

const point = (THREE: any, x: number, z: number, y = 1.4) => new THREE.Vector3(x, y, z);

export default function PortMap3D({ selectedShip, onSelectShip, weather, simulated = false, scenarioId, command, compact = false }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<MapApi | null>(null);

  const callbackRef = useRef(onSelectShip);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    callbackRef.current = onSelectShip;
  }, [onSelectShip]);

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | undefined;
    const root = rootRef.current;
    if (!root) return;

    async function initialize() {
      try {
        const THREE = await getThree();
        if (cancelled || !root) return;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color("#081824");
        scene.fog = new THREE.FogExp2("#081824", 0.0056);

        const renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true, powerPreference: "high-performance" });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.55;
        renderer.domElement.className = "port-webgl-canvas";
        renderer.domElement.setAttribute("aria-label", "Interactive 3D port and vessel map");
        root.appendChild(renderer.domElement);

        const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 500);
        const currentTarget = new THREE.Vector3(-7, 0, -1);
        const desiredTarget = new THREE.Vector3(-7, 0, -1);
        let radius = 123;
        let azimuth = -0.36;
        let polar = 0.81;
        let smoothRadius = radius;
        camera.position.set(-33, 83, 83);
        camera.lookAt(currentTarget);

        scene.add(new THREE.AmbientLight("#c7e5ee", 2.1));
        const sunlight = new THREE.DirectionalLight("#e9faf9", 2.7);
        sunlight.position.set(-35, 70, 24);
        scene.add(sunlight);
        const fill = new THREE.DirectionalLight("#4a9cb6", 1.8);
        fill.position.set(26, 28, -45);
        scene.add(fill);

        const makeMat = (color: string, opts: Record<string, unknown> = {}) => new THREE.MeshStandardMaterial({ color, metalness: 0.12, roughness: 0.74, ...opts });
        const sea = new THREE.Mesh(new THREE.BoxGeometry(181, 1.2, 130), makeMat("#0b2a37", { metalness: 0.28, roughness: 0.67 }));
        sea.position.set(-6, -1.25, 0);
        scene.add(sea);

        const grid = new THREE.GridHelper(182, 46, "#23566a", "#184251");
        grid.position.set(-6, -0.54, 0);
        (grid.material as any).transparent = true;
        (grid.material as any).opacity = 0.52;
        scene.add(grid);

        // Coastline, channel, piers, terminal buildings, cranes and cargo stacks.
        const land = new THREE.Group();
        scene.add(land);
        const shore = new THREE.Mesh(new THREE.BoxGeometry(58, 1.9, 132), makeMat("#223441"));
        shore.position.set(62, -0.32, 0);
        land.add(shore);
        const shoreEdge = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.5, 130), makeMat("#547484", { emissive: "#1b3847", emissiveIntensity: 0.2 }));
        shoreEdge.position.set(33.5, 0.12, 0);
        land.add(shoreEdge);
        const terminal = new THREE.Mesh(new THREE.BoxGeometry(20, 0.35, 101), makeMat("#334955"));
        terminal.position.set(44, 0.72, -1);
        land.add(terminal);
        const road = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.08, 114), makeMat("#4b5962"));
        road.position.set(52, 0.91, 0);
        land.add(road);

        const stackColors = ["#bc8c63", "#6f9d9c", "#7686a4", "#b8b6a0", "#997d71"];
        for (let row = 0; row < 6; row++) {
          for (let col = 0; col < 6; col++) {
            const stack = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.8 + ((col + row) % 3) * 0.6, 1.6), makeMat(stackColors[(row * 3 + col) % stackColors.length]));
            stack.position.set(40 + (col % 2) * 4.8, 2.15, -46 + row * 16 + (col > 3 ? 4.3 : 0));
            land.add(stack);
          }
        }
        for (const z of [-36, -19, -2, 15, 32]) {
          const pier = new THREE.Mesh(new THREE.BoxGeometry(27, 1.45, 5.1), makeMat("#597480"));
          pier.position.set(22.5, 0.22, z);
          land.add(pier);
          for (const x of [16, 25, 34]) {
            const pole = new THREE.Mesh(new THREE.BoxGeometry(0.57, 8.0, 0.57), makeMat("#83a8b4", { metalness: 0.5 }));
            pole.position.set(x, 5, z + 1.8);
            land.add(pole);
            const boom = new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 0.48), makeMat("#86bbc6"));
            boom.position.set(x - 2.6, 8.4, z + 1.8);
            land.add(boom);
            const support = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.2, 0.25), makeMat("#95b2b6"));
            support.position.set(x - 5.4, 7.2, z + 1.8);
            land.add(support);
          }
          for (let k = 0; k < 4; k++) {
            const item = new THREE.Mesh(new THREE.BoxGeometry(3.3, 1.5, 1.1), makeMat(stackColors[(k + z + 100) % stackColors.length]));
            item.position.set(17 + k * 4.7, 1.8, z - 0.6);
            land.add(item);
          }
        }
        for (let i = 0; i < 23; i++) {
          const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.21, 8, 8), new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? "#f0b66a" : "#65dfd0" }));
          beacon.position.set(11.2, 1.17, -51 + i * 4.6);
          land.add(beacon);
        }
        // Offshore heading markers.
        for (let i = 0; i < 8; i++) {
          const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.32, 8), new THREE.MeshBasicMaterial({ color: "#397c8d" }));
          marker.position.set(-65 + i * 13.5, 0.05, -58);
          scene.add(marker);
        }

        const routeObjects: any[] = [];
        const vesselObjects: { mesh: any; ship: Ship; curve: any; baseProgress: number; glow: any }[] = [];
        const selectable: any[] = [];
        const labelElements: { element: HTMLButtonElement; point: any; id: string }[] = [];
        const labelsLayer = document.createElement("div");
        labelsLayer.className = "port-map-labels";
        root.appendChild(labelsLayer);

        const addShip = (ship: Ship) => {
          const route = new THREE.CatmullRomCurve3(ship.route.map(([x, z]) => point(THREE, x, z, 0.35)), false, "catmullrom", 0.5);
          const pts = route.getPoints(110);
          const routeGeometry = new THREE.BufferGeometry().setFromPoints(pts);
          const track = new THREE.Line(routeGeometry, new THREE.LineDashedMaterial({ color: ship.priority === "Critical" ? "#5dd7ca" : "#50798e", dashSize: 1.4, gapSize: 0.85, transparent: true, opacity: ship.priority === "Critical" ? 0.95 : 0.75 }));
          track.computeLineDistances();
          scene.add(track);
          routeObjects.push(track);
          const group = new THREE.Group();
          group.userData.shipId = ship.id;
          const hull = new THREE.Mesh(new THREE.BoxGeometry(7.7, 1.42, 2.75), makeMat("#aac3c9", { metalness: 0.42, roughness: 0.44 }));
          hull.position.y = 0.55;
          group.add(hull);
          const bow = new THREE.Mesh(new THREE.ConeGeometry(1.34, 2.2, 4), makeMat("#a8c3cc", { metalness: 0.42 }));
          bow.rotation.z = -Math.PI / 2;
          bow.rotation.x = Math.PI / 4;
          bow.position.set(4.2, 0.55, 0);
          group.add(bow);
          const deck = new THREE.Mesh(new THREE.BoxGeometry(6.7, 0.24, 2.8), makeMat("#324c5d"));
          deck.position.y = 1.36;
          group.add(deck);
          for (let row = 0; row < 2; row++) {
            for (let col = 0; col < 3; col++) {
              const container = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.94, 1.12), makeMat((ship.priority === "Critical" && col === 0) ? "#58bea9" : stackColors[(col + row * 2 + ship.id.length) % stackColors.length]));
              container.position.set(-0.6 + col * 1.65, 1.97, -0.67 + row * 1.34);
              group.add(container);
            }
          }
          const bridge = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 2.1), makeMat("#d9dfd8"));
          bridge.position.set(-3.05, 2.0, 0);
          group.add(bridge);
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.9, 8), makeMat("#c4dfdf"));
          mast.position.set(-3.05, 4.05, 0);
          group.add(mast);
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 10), new THREE.MeshBasicMaterial({ color: ship.color }));
          dot.position.set(-3.05, 5.05, 0);
          group.add(dot);
          const halo = new THREE.Mesh(new THREE.RingGeometry(4.7, 5, 48), new THREE.MeshBasicMaterial({ color: ship.color, transparent: true, opacity: 0.84, side: THREE.DoubleSide, depthWrite: false }));
          halo.rotation.x = -Math.PI / 2;
          halo.position.y = 0.14;
          group.add(halo);
          scene.add(group);
          group.traverse((child: any) => { if (child.isMesh) { child.userData.shipId = ship.id; selectable.push(child); } });
          vesselObjects.push({ mesh: group, ship, curve: route, baseProgress: ship.progress, glow: halo });
          const label = document.createElement("button");
          label.type = "button";
          label.className = "ship-map-label";
          const labelDot = document.createElement("span");
          labelDot.className = "ship-map-label__dot";
          labelDot.style.background = ship.color;
          const labelName = document.createElement("span");
          labelName.textContent = ship.name;
          label.append(labelDot, labelName);
          label.addEventListener("click", (event) => { event.stopPropagation(); callbackRef.current(ship.id); applyCommand({ kind: "focusShip", shipId: ship.id, nonce: Date.now() }); });
          labelsLayer.appendChild(label);
          labelElements.push({ element: label, point: new THREE.Vector3(), id: ship.id });
        };
        SHIPS.forEach(addShip);

        const portLabel = document.createElement("div");
        portLabel.className = "map-port-label";
        portLabel.innerHTML = `<span class="map-port-label__pin">✦</span><span>PORT OF LOS ANGELES<small>5 ACTIVE TERMINALS</small></span>`;
        labelsLayer.appendChild(portLabel);

        const weatherGroup = new THREE.Group();
        scene.add(weatherGroup);
        const updateWeather = (area: WeatherArea, isSimulated: boolean) => {
          while (weatherGroup.children.length) {
            const child = weatherGroup.children[0];
            weatherGroup.remove(child);
            child.geometry?.dispose();
            child.material?.dispose();
          }
          const c = new THREE.Color(area.color);
          const surface = new THREE.Mesh(new THREE.CircleGeometry(area.radius, 96), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: isSimulated ? 0.155 : 0.082, side: THREE.DoubleSide, depthWrite: false }));
          surface.rotation.x = -Math.PI / 2;
          surface.position.set(area.x, 0.07, area.z);
          weatherGroup.add(surface);
          for (let k = 0; k < 3; k++) {
            const size = area.radius * (1 - k * 0.23);
            const ring = new THREE.Mesh(new THREE.RingGeometry(size - (k === 0 ? 0.48 : 0.18), size, 128), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: isSimulated ? (0.78 - k * 0.19) : (0.40 - k * 0.1), side: THREE.DoubleSide, depthWrite: false }));
            ring.rotation.x = -Math.PI / 2;
            ring.position.set(area.x, 0.09 + k * 0.03, area.z);
            weatherGroup.add(ring);
          }
          const center = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 12), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.8 }));
          center.position.set(area.x, 0.8, area.z);
          weatherGroup.add(center);
        };
        updateWeather(weather, simulated);

        const applyCommand = (cmd: MapCommand) => {
          switch (cmd.kind) {
            case "reset": desiredTarget.set(-7, 0, -1); radius = 123; break;
            case "zoomIn": radius = Math.max(25, radius * 0.75); break;
            case "zoomOut": radius = Math.min(186, radius * 1.25); break;
            case "focusPort": desiredTarget.set(21, 0, 0); radius = 52; break;
            case "focusShip": {
              const vessel = vesselObjects.find((item) => item.ship.id === cmd.shipId);
              if (vessel) { desiredTarget.copy(vessel.mesh.position); desiredTarget.y = 0; radius = 36; }
              break;
            }
          }
        };
        const setSelected = (id: string) => {
          for (const vessel of vesselObjects) {
            vessel.glow.visible = vessel.ship.id === id;
          }
          for (const label of labelElements) label.element.classList.toggle("is-selected", label.id === id);
        };
        setSelected(selectedShip);

        const raycaster = new THREE.Raycaster();
        const pointerNdc = new THREE.Vector2();
        let down: { x: number; y: number } | undefined;
        let moved = false;
        let lastDrag = { x: 0, y: 0 };
        const onDown = (event: PointerEvent) => {
          down = { x: event.clientX, y: event.clientY };
          lastDrag = { x: event.clientX, y: event.clientY };
          moved = false;
          renderer.domElement.setPointerCapture?.(event.pointerId);
        };
        const onMove = (event: PointerEvent) => {
          if (!down) return;
          const dx = event.clientX - lastDrag.x;
          const dy = event.clientY - lastDrag.y;
          if (Math.abs(event.clientX - down.x) + Math.abs(event.clientY - down.y) > 5) moved = true;
          if (moved) {
            if (event.shiftKey || event.buttons === 2) {
              azimuth -= dx * 0.006;
              polar = Math.max(0.42, Math.min(1.25, polar + dy * 0.004));
            } else {
              const speed = radius / 390;
              desiredTarget.x -= dx * speed;
              desiredTarget.z -= dy * speed;
              desiredTarget.x = Math.max(-62, Math.min(44, desiredTarget.x));
              desiredTarget.z = Math.max(-55, Math.min(55, desiredTarget.z));
            }
          }
          lastDrag = { x: event.clientX, y: event.clientY };
        };
        const onUp = (event: PointerEvent) => {
          if (down && !moved) {
            const bounds = renderer.domElement.getBoundingClientRect();
            pointerNdc.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
            raycaster.setFromCamera(pointerNdc, camera);
            const hits = raycaster.intersectObjects(selectable, false);
            const id = hits[0]?.object?.userData?.shipId;
            if (id) { callbackRef.current(id); applyCommand({ kind: "focusShip", shipId: id, nonce: Date.now() }); }
          }
          down = undefined;
        };
        const onWheel = (event: WheelEvent) => {
          event.preventDefault();
          radius = Math.max(25, Math.min(186, radius * (event.deltaY > 0 ? 1.10 : 0.90)));
        };
        const noContext = (event: MouseEvent) => event.preventDefault();
        renderer.domElement.addEventListener("pointerdown", onDown);
        renderer.domElement.addEventListener("pointermove", onMove);
        renderer.domElement.addEventListener("pointerup", onUp);
        renderer.domElement.addEventListener("pointercancel", onUp);
        renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
        renderer.domElement.addEventListener("contextmenu", noContext);

        const resize = () => {
          const width = root.clientWidth || 600;
          const height = root.clientHeight || 400;
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        const observer = new ResizeObserver(resize);
        observer.observe(root);
        resize();
        const projected = new THREE.Vector3();
        let frame = 0;
        let raf = 0;
        const animate = () => {
          raf = requestAnimationFrame(animate);
          frame++;
          smoothRadius += (radius - smoothRadius) * 0.075;
          currentTarget.lerp(desiredTarget, 0.075);
          const horizontal = smoothRadius * Math.sin(polar);
          const desiredPosition = new THREE.Vector3(currentTarget.x + Math.sin(azimuth) * horizontal, smoothRadius * Math.cos(polar), currentTarget.z + Math.cos(azimuth) * horizontal);
          camera.position.lerp(desiredPosition, 0.075);
          camera.lookAt(currentTarget);
          for (let i = 0; i < vesselObjects.length; i++) {
            const vessel = vesselObjects[i];
            const p = Math.min(0.975, vessel.baseProgress + Math.sin(frame * 0.0011 + i) * 0.0014);
            const world = vessel.curve.getPointAt(p);
            const tangent = vessel.curve.getTangentAt(p);
            vessel.mesh.position.copy(world);
            vessel.mesh.position.y = 0.68 + Math.sin(frame * 0.025 + i * 2) * 0.075;
            vessel.mesh.rotation.y = -Math.atan2(tangent.z, tangent.x);
            const label = labelElements[i];
            projected.copy(world); projected.y = 5.8; projected.project(camera);
            const w = root.clientWidth;
            const h = root.clientHeight;
            const off = projected.z > 1 || Math.abs(projected.x) > 1.17 || Math.abs(projected.y) > 1.13;
            label.element.style.display = off ? "none" : "flex";
            label.element.style.left = `${(projected.x * 0.5 + 0.5) * w}px`;
            label.element.style.top = `${(-projected.y * 0.5 + 0.5) * h}px`;
          }
          projected.set(30, 9, -45).project(camera);
          portLabel.style.left = `${(projected.x * 0.5 + 0.5) * root.clientWidth}px`;
          portLabel.style.top = `${(-projected.y * 0.5 + 0.5) * root.clientHeight}px`;
          portLabel.style.display = projected.z > 1 || Math.abs(projected.x) > 1.13 ? "none" : "flex";
          renderer.render(scene, camera);
        };
        animate();

        apiRef.current = { command: applyCommand, setWeather: updateWeather, setSelected, destroy: () => {
          cancelAnimationFrame(raf);
          observer.disconnect();
          renderer.domElement.removeEventListener("pointerdown", onDown);
          renderer.domElement.removeEventListener("pointermove", onMove);
          renderer.domElement.removeEventListener("pointerup", onUp);
          renderer.domElement.removeEventListener("pointercancel", onUp);
          renderer.domElement.removeEventListener("wheel", onWheel);
          renderer.domElement.removeEventListener("contextmenu", noContext);
          scene.traverse((item: any) => { if (item.geometry) item.geometry.dispose(); if (item.material) { if (Array.isArray(item.material)) item.material.forEach((m: any) => m.dispose()); else item.material.dispose(); } });
          renderer.dispose();
          renderer.domElement.remove();
          labelsLayer.remove();
        } };
        teardown = () => apiRef.current?.destroy();
        setReady(true);
      } catch (e) {
        console.error("Three.js map could not initialize:", e);
        if (!cancelled) setError(true);
      }
    }
    initialize();
    return () => { cancelled = true; if (teardown) teardown(); apiRef.current = null; };
  // Component is intentionally created once; changes flow through the API ref below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Synchronize again when the asynchronous map initialization finishes.
  useEffect(() => { if (ready) apiRef.current?.setWeather(weather, simulated); }, [ready, weather, simulated]);
  useEffect(() => { if (ready) apiRef.current?.setSelected(selectedShip); }, [ready, selectedShip]);
  useEffect(() => { if (ready && command) apiRef.current?.command(command); }, [ready, command]);

  return (
    <div className={`port-map-root ${compact ? "port-map-root--compact" : ""}`} ref={rootRef}>
      {!ready && !error && <div className="map-loading"><span className="map-loading__spinner"/><span>Initializing 3D maritime view…</span></div>}
      {error && <div className="map-loading map-loading--error"><Icon name="alert" size={26}/><strong>3D view unavailable</strong><span>WebGL and a connection to the Three.js CDN are required.</span><button onClick={() => window.location.reload()}>Retry map</button></div>}
      {ready && <div className="map-controls-help"><Icon name="route" size={13}/> SCROLL TO ZOOM <span>·</span> DRAG TO PAN <span>·</span> SHIFT + DRAG TO ORBIT</div>}
      {simulated && ready && <div className="map-sim-stamp">SCENARIO ACTIVE <span>·</span> {scenarioId === "outage" ? "TERMINAL IMPACT" : "WEATHER FOOTPRINT"}</div>}
    </div>
  );
}
