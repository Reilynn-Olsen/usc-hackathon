"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import type { ScenarioId } from "../lib/data";
import type { MapVessel } from "../lib/vessel-state";
import { Icon } from "../lib/icons";
import { PIER_Z } from "../lib/port-layout";

export type MapCommand = { kind: "reset" | "zoomIn" | "zoomOut" | "focusShip" | "focusPort"; shipId?: string; nonce: number };
type WeatherArea = { x: number; z: number; radius: number; color: string };
type Props = {
  vessels: MapVessel[];
  berthCount?: number;
  selectedShip: string;
  onSelectShip: (id: string) => void;
  weather: WeatherArea;
  simulated?: boolean;
  weatherStrength?: number;
  weatherActive?: boolean;
  scenarioId?: ScenarioId;
  command?: MapCommand;
  compact?: boolean;
};

type MapApi = {
  setBerthCount: (count: number) => void;
  setVessels: (vessels: MapVessel[]) => void;
  command: (command: MapCommand) => void;
  setWeather: (weather: WeatherArea, strength: number, active: boolean, kind?: ScenarioId) => void;
  setSelected: (shipId: string) => void;
  destroy: () => void;
};

async function getThree() {
  return import("three");
}

const point = (THREE: any, x: number, z: number, y = 1.4) => new THREE.Vector3(x, y, z);

export default function PortMap3D({ vessels, berthCount = PIER_Z.length, selectedShip, onSelectShip, weather, simulated = false, weatherStrength = 0.45, weatherActive = true, scenarioId, command, compact = false }: Props) {
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
        for (const z of PIER_Z) {
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

        const makeWarningMarker = (color: string) => {
          const warning = new THREE.Group();
          warning.position.y = 15;
          const triangle = new THREE.Shape();
          triangle.moveTo(0, 4.8);
          triangle.lineTo(-5, -3.8);
          triangle.lineTo(5, -3.8);
          triangle.closePath();
          warning.add(new THREE.Mesh(new THREE.ShapeGeometry(triangle), new THREE.MeshBasicMaterial({ color: "#512626", side: THREE.DoubleSide })));
          const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 4.8, 0.1), new THREE.Vector3(-5, -3.8, 0.1),
            new THREE.Vector3(5, -3.8, 0.1), new THREE.Vector3(0, 4.8, 0.1),
          ]), new THREE.LineBasicMaterial({ color: "#ffb878" }));
          warning.add(outline);
          const bar = new THREE.Mesh(new THREE.BoxGeometry(0.8, 3.5, 0.3), new THREE.MeshBasicMaterial({ color: "#ffd598" }));
          bar.position.set(0, 0.5, 0.3);
          warning.add(bar);
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.46, 12, 8), new THREE.MeshBasicMaterial({ color: "#ffd598" }));
          dot.position.set(0, -2.3, 0.3);
          warning.add(dot);
          const post = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 10.5, 0),
          ]), new THREE.LineDashedMaterial({ color, dashSize: 0.7, gapSize: 0.5 }));
          post.computeLineDistances();
          const marker = new THREE.Group();
          marker.add(post, warning);
          return { marker, warning };
        };

        // Piers outside the modeled berth capacity stay visibly unavailable.
        const unusedPierWarnings = PIER_Z.map((z) => {
          const { marker, warning } = makeWarningMarker("#e4777a");
          marker.position.set(23, 0, z);
          scene.add(marker);
          return { marker, warning };
        });
        const setBerthCount = (count: number) => {
          for (const [index, { marker }] of unusedPierWarnings.entries()) {
            marker.visible = index >= Math.max(0, count);
          }
        };
        setBerthCount(berthCount);

        const vesselObjects: { mesh: any; ship: MapVessel; track: any; glow: any }[] = [];
        const selectable: any[] = [];
        const labelElements: { element: HTMLButtonElement; point: any; id: string }[] = [];
        const labelsLayer = document.createElement("div");
        labelsLayer.className = "port-map-labels";
        root.appendChild(labelsLayer);

        const addShip = (ship: MapVessel) => {
          const track = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: ship.color, dashSize: 1.4, gapSize: 0.85, transparent: true, opacity: 0.55 }));
          scene.add(track);
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
          group.traverse((child: any) => { if (child.isMesh) { child.userData.shipId = ship.id; } });
          vesselObjects.push({ mesh: group, ship, track, glow: halo });
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
        const disposeObject = (object: any) => {
          scene.remove(object);
          object.traverse((child: any) => {
            child.geometry?.dispose();
            if (Array.isArray(child.material)) child.material.forEach((material: any) => material.dispose());
            else child.material?.dispose();
          });
        };
        const setVessels = (ships: MapVessel[]) => {
          const ids = new Set(ships.map((ship) => ship.id));
          for (let index = vesselObjects.length - 1; index >= 0; index--) {
            const vessel = vesselObjects[index];
            if (ids.has(vessel.ship.id)) continue;
            disposeObject(vessel.mesh);
            disposeObject(vessel.track);
            labelElements[index].element.remove();
            labelElements.splice(index, 1);
            vesselObjects.splice(index, 1);
          }
          selectable.length = 0;
          for (const ship of ships) {
            let vessel = vesselObjects.find((item) => item.ship.id === ship.id);
            if (!vessel) { addShip(ship); vessel = vesselObjects[vesselObjects.length - 1]; }
            vessel.ship = ship;
            vessel.glow.scale.z = ship.status === "berthed" ? 0.45 : 1;
            vessel.mesh.position.set(ship.mapPosition[0], 0.68, ship.mapPosition[1]);
            vessel.mesh.rotation.y = (90 - ship.mapHeading) * Math.PI / 180;
            vessel.track.geometry.dispose();
            vessel.track.geometry = new THREE.BufferGeometry().setFromPoints(ship.route.map(([x, z]) => point(THREE, x, z, 0.35)));
            vessel.track.computeLineDistances();
            vessel.track.visible = ship.route.some(([x, z]) => x !== ship.route[0][0] || z !== ship.route[0][1]);
            vessel.mesh.traverse((child: any) => { if (child.isMesh) selectable.push(child); });
            const label = labelElements.find((item) => item.id === ship.id)!;
            label.element.title = `${ship.name} · ${ship.status} · ${ship.containers} containers`;
            label.element.children[1].textContent = ship.name;
          }
        };
        setVessels(vessels);

        const portLabel = document.createElement("div");
        portLabel.className = "map-port-label";
        portLabel.innerHTML = `<span class="map-port-label__pin">✦</span><span>PORT OF LOS ANGELES<small>SCHEMATIC HARBOR & VESSEL POSITIONS</small></span>`;
        labelsLayer.appendChild(portLabel);

        const weatherGroup = new THREE.Group();
        scene.add(weatherGroup);
        const weatherMaterials: any[] = [];
        let equipmentWarning: any = null;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        const updateWeather = (area: WeatherArea, strength: number, active: boolean, kind: ScenarioId = "wind") => {
          weatherGroup.traverse((child: any) => {
            child.geometry?.dispose();
            if (Array.isArray(child.material)) child.material.forEach((material: any) => material.dispose());
            else child.material?.dispose();
          });
          weatherGroup.clear();
          weatherMaterials.length = 0;
          equipmentWarning = null;
          // Weather covers the entire modeled water surface; equipment remains local.
          const isEquipment = kind === "outage";
          const waterMinX = -96.5;
          const waterMaxX = 32.9;
          const fieldWidth = isEquipment ? area.radius * 2 : waterMaxX - waterMinX;
          const fieldDepth = isEquipment ? area.radius * 2 : 130;
          weatherGroup.position.set(isEquipment ? area.x : (waterMinX + waterMaxX) / 2, 0, isEquipment ? area.z : 0);
          weatherGroup.visible = active && strength > 0;
          if (!weatherGroup.visible) return;
          const intensity = Math.max(0, Math.min(1, strength));
          const kindIndex = { wind: 0, storm: 1, fog: 2, outage: 3 }[kind];
          const uniforms = {
            uTime: { value: 0 },
            uStrength: { value: intensity },
            uPierZ: { value: [...PIER_Z] },
            uKind: { value: kindIndex },
            uColor: { value: new THREE.Color(kind === "outage" ? area.color : kind === "fog" ? "#9bb6c4" : "#6b9caa") },
          };
          // A single subtle surface layer keeps weather blended with the sea.
          const fragmentShader = `
            uniform float uTime;
            uniform float uStrength;
            uniform float uKind;
            uniform vec3 uColor;
            uniform float uPierZ[5];
            varying vec2 vUv;
            varying vec2 vWorldXZ;
            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float noise(vec2 p) {
              vec2 i = floor(p), f = fract(p);
              f = f * f * (3.0 - 2.0 * f);
              return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x),
                         mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
            }
            float windStreak(vec2 p) {
              vec2 flow = vec2(p.x + p.y * 0.35, p.y - p.x * 0.18);
              float lane = floor(flow.y * 20.0);
              float bend = sin(flow.x * 6.0 + lane) * 0.10;
              float line = 1.0 - smoothstep(0.015, 0.11, abs(fract(flow.y * 20.0 + bend) - 0.5));
              float streak = pow(max(0.0, sin(flow.x * 11.0 - uTime * 1.8 + lane * 2.4)), 5.0);
              return line * streak;
            }
            void main() {
              vec2 p = vUv * 2.0 - 1.0;
              float edge = 1.0;
              if (uKind > 2.5) {
                float r = length(p);
                if (r >= 1.0) discard;
                edge = 1.0 - smoothstep(0.82, 1.0, r);
              } else {
                // Exclude the solid piers so the tint only touches water.
                if (vWorldXZ.x >= 9.0) {
                  for (int i = 0; i < 5; i++) {
                    if (abs(vWorldXZ.y - uPierZ[i]) <= 2.55) discard;
                  }
                }
              }
              vec2 drift = vec2(uTime * 0.035, -uTime * 0.012);
              float cloud = noise(p * 4.0 - drift) * 0.65
                          + noise(p * 9.0 - drift * 1.7) * 0.35;
              float alpha;
              vec3 color = uColor;
              if (uKind < 0.5) {
                alpha = 0.045 * cloud + windStreak(p) * 0.65;
              } else if (uKind < 2.5) {
                // Both fog scenarios share the same drifting cloud pattern.
                float fogDensity = smoothstep(0.22, 0.85, cloud);
                if (uKind < 1.5) {
                  // Dark charcoal fog stays beneath the ship hulls to preserve their visibility.
                  color = mix(vec3(0.007), vec3(0.022), fogDensity);
                  color = mix(color, vec3(0.065), windStreak(p) * 0.10);
                  alpha = mix(0.82, 0.98, fogDensity);
                } else {
                  alpha = fogDensity * 0.36;
                }
              } else {
                float hatch = 1.0 - smoothstep(0.04, 0.12, abs(fract((p.x + p.y) * 12.0) - 0.5));
                alpha = 0.16 + hatch * 0.40;
              }
              float strength = uKind > 0.5 && uKind < 1.5 ? sqrt(uStrength) : uStrength;
              gl_FragColor = vec4(color, alpha * edge * strength);
              #include <tonemapping_fragment>
              #include <colorspace_fragment>
            }
          `;
          const material = new THREE.ShaderMaterial({
            uniforms,
            vertexShader: `
              varying vec2 vUv;
              varying vec2 vWorldXZ;
              void main() {
                vUv = uv;
                vWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
              }
            `,
            fragmentShader,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
          });
          const field = new THREE.Mesh(new THREE.PlaneGeometry(fieldWidth, fieldDepth), material);
          field.rotation.x = -Math.PI / 2;
          field.position.y = isEquipment ? 1.1 : 0.15;
          weatherGroup.add(field);
          weatherMaterials.push(material);
          if (kind === "outage") {
            const { marker, warning } = makeWarningMarker(area.color);
            weatherGroup.add(marker);
            equipmentWarning = warning;
          }
        };
        updateWeather(weather, weatherStrength, weatherActive, scenarioId);

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
        let raf = 0;
        const animate = () => {
          raf = requestAnimationFrame(animate);
          smoothRadius += (radius - smoothRadius) * 0.075;
          currentTarget.lerp(desiredTarget, 0.075);
          const horizontal = smoothRadius * Math.sin(polar);
          const desiredPosition = new THREE.Vector3(currentTarget.x + Math.sin(azimuth) * horizontal, smoothRadius * Math.cos(polar), currentTarget.z + Math.cos(azimuth) * horizontal);
          camera.position.lerp(desiredPosition, 0.075);
          camera.lookAt(currentTarget);
          for (let i = 0; i < vesselObjects.length; i++) {
            const vessel = vesselObjects[i];
            const world = point(THREE, ...vessel.ship.mapPosition, 0.68);
            vessel.mesh.position.copy(world);
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
          if (equipmentWarning) equipmentWarning.quaternion.copy(camera.quaternion);
          for (const { marker, warning } of unusedPierWarnings) {
            if (marker.visible) warning.quaternion.copy(camera.quaternion);
          }
          const weatherTime = reduceMotion.matches ? 0 : performance.now() / 1000;
          for (const material of weatherMaterials) material.uniforms.uTime.value = weatherTime;
          renderer.render(scene, camera);
        };
        animate();

        apiRef.current = { setBerthCount, setVessels, command: applyCommand, setWeather: updateWeather, setSelected, destroy: () => {
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
  useEffect(() => { if (ready) apiRef.current?.setBerthCount(berthCount); }, [ready, berthCount]);
  useEffect(() => { if (ready) apiRef.current?.setWeather(weather, weatherStrength, weatherActive, scenarioId); }, [ready, weather, weatherStrength, weatherActive, scenarioId]);
  useEffect(() => { if (ready) { apiRef.current?.setVessels(vessels); apiRef.current?.setSelected(selectedShip); } }, [ready, vessels, selectedShip]);
  useEffect(() => { if (ready && command) apiRef.current?.command(command); }, [ready, command]);

  return (
    <div className={`port-map-root ${compact ? "port-map-root--compact" : ""}`} ref={rootRef}>
      {!ready && !error && <div className="map-loading"><span className="map-loading__spinner"/><span>Initializing 3D maritime view…</span></div>}
      {error && <div className="map-loading map-loading--error"><Icon name="alert" size={26}/><strong>3D view unavailable</strong><span>The 3D view could not load. Check that WebGL is enabled in your browser.</span><button onClick={() => window.location.reload()}>Retry map</button></div>}
      {ready && <div className="map-controls-help"><Icon name="route" size={13}/> SCROLL TO ZOOM <span>·</span> DRAG TO PAN <span>·</span> SHIFT + DRAG TO ORBIT</div>}
      {ready && <div className="map-weather-key" role="note">
        <Icon name={scenarioId ?? "wind"} size={19}/>
        <span>{scenarioId === "storm" ? "Storm conditions" : scenarioId === "fog" ? "Low visibility / fog" : scenarioId === "outage" ? weatherActive && weatherStrength > 0 ? "Equipment failure · berth closed" : "Equipment failure · repaired" : "Wind / gusts"}<small>{simulated ? weatherActive && weatherStrength > 0 ? scenarioId === "outage" ? "LOCAL BERTH CLOSURE" : "HARBOR-WIDE WEATHER" : "DISRUPTION INACTIVE" : "ILLUSTRATIVE CONDITIONS"}</small></span>
      </div>}
    </div>
  );
}
