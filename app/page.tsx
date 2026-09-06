'use client';

import { ChangeEvent, UIEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { LatLng, Map as LeafletMap, Point } from 'leaflet';
import Image from 'next/image';

type Dataset = { id: string; country: string; year: number; releaseType: string; source: string; sourceShort: string; file: string; subdivisionLabel: string; performanceNote?: string };
type CsvValue = string | number | boolean | null | undefined;
type Place = { code: string; name: string; state: string; country: string; latitude: number | null; longitude: number | null; population: number; nicknames?: string; datasetId?: string; [key: string]: CsvValue };
const format = new Intl.NumberFormat('en-US');
const TABLE_ROW_HEIGHT = 50;
const TABLE_OVERSCAN = 8;
const DOT_GROWTH_START_ZOOM = 15;
const NODE_RADIUS = 3;
const POPULATION_RADIUS_SCALE = 0.006;
const MAX_RENDERED_POINTS = 25000;
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const baseDotRadius = (population: number, minimumRadius = NODE_RADIUS) => {
  const safePopulation = Number.isFinite(population) ? Math.max(population, 0) : 0;
  return minimumRadius + POPULATION_RADIUS_SCALE * Math.sqrt(safePopulation);
};
const dotRadius = (population: number, zoom: number, minimumRadius = NODE_RADIUS) => {
  const growthSteps = Math.max(0, zoom - DOT_GROWTH_START_ZOOM + 1);
  const mapScale = 2 ** growthSteps;
  return baseDotRadius(population, minimumRadius) * mapScale;
};
const placeKey = (place: Place) => {
  const dataset = place.datasetId ?? place.country;
  const code = String(place.code ?? '').trim();
  return code
    ? `${dataset}:${code}`
    : `${dataset}:${place.name}:${place.state}:${place.latitude ?? ''}:${place.longitude ?? ''}:${place.population ?? ''}`;
};
const hasCoordinates = (place: Place): place is Place & { latitude: number; longitude: number } =>
  Number.isFinite(place.latitude) && Number.isFinite(place.longitude);
const localizedNames = (place: Place) => Object.entries(place)
  .filter(([key, value]) => /^name_[a-z]{2,3}(?:_[a-z0-9]+)?$/i.test(key) && typeof value === 'string' && value.trim())
  .map(([key, value]) => ({ code: key.slice(5).replace('_', '-').toUpperCase(), value: String(value) }));
const normalizeSearchText = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/['’ʻʼ`´]/g, '')
  .replace(/[‐‑‒–—―-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase();
const csvCell = (value: CsvValue) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function createDotRenderer(element: HTMLCanvasElement) {
  const gl = element.getContext('webgl', { alpha: true, antialias: true });
  if (!gl) return null;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not create map shader.');
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Map shader failed.');
    return shader;
  };
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, `
    precision highp float;
    attribute vec3 a_point;
    uniform vec2 u_anchor;
    uniform vec2 u_viewport;
    uniform float u_world_scale;
    uniform float u_radius_scale;
    uniform float u_min_radius;
    uniform float u_population_scale;
    uniform float u_max_size;
    uniform float u_outline;
    varying mediump float v_size;
    void main() {
      vec2 pixel = u_anchor + a_point.xy * u_world_scale;
      vec2 clip = (pixel / u_viewport) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      float radius = u_min_radius + u_population_scale * a_point.z;
      v_size = min(radius * 2.0 * u_radius_scale + u_outline, u_max_size);
      gl_PointSize = v_size;
    }
  `));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying mediump float v_size;
    uniform float u_outline;
    void main() {
      float distance_in_pixels = distance(gl_PointCoord, vec2(0.5)) * v_size;
      float outer_radius = v_size * 0.5;
      float fill_radius = outer_radius - u_outline;
      float antialias = 0.75;
      float outer_alpha = 1.0 - smoothstep(outer_radius - antialias, outer_radius, distance_in_pixels);
      if (outer_alpha <= 0.0) discard;
      float border_mix = smoothstep(fill_radius - antialias * 0.5, fill_radius + antialias * 0.5, distance_in_pixels);
      vec4 fill_color = vec4(0.854902, 0.419608, 0.403922, 0.60);
      vec4 border_color = vec4(0.0, 0.0, 0.0, 0.92);
      vec4 color = mix(fill_color, border_color, border_mix);
      gl_FragColor = vec4(color.rgb, color.a * outer_alpha);
    }
  `));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Map renderer failed.');
  const buffer = gl.createBuffer();
  if (!buffer) return null;
  const pointLocation = gl.getAttribLocation(program, 'a_point');
  const anchorLocation = gl.getUniformLocation(program, 'u_anchor');
  const viewportLocation = gl.getUniformLocation(program, 'u_viewport');
  const worldScaleLocation = gl.getUniformLocation(program, 'u_world_scale');
  const radiusScaleLocation = gl.getUniformLocation(program, 'u_radius_scale');
  const minimumRadiusLocation = gl.getUniformLocation(program, 'u_min_radius');
  const populationScaleLocation = gl.getUniformLocation(program, 'u_population_scale');
  const maxSizeLocation = gl.getUniformLocation(program, 'u_max_size');
  const outlineLocation = gl.getUniformLocation(program, 'u_outline');
  const maxPointSize = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1];
  let bufferedPlaces: Place[] | null = null;
  let pointCount = 0;

  const setPlaces = (places: Place[]) => {
    if (places === bufferedPlaces) return;
    const data = new Float32Array(places.length * 3);
    let offset = 0;
    for (const place of places) {
      const latitude = Math.max(-85.05112878, Math.min(85.05112878, place.latitude as number));
      const longitude = place.longitude as number;
      const sine = Math.sin(latitude * Math.PI / 180);
      data[offset++] = ((longitude + 180) / 360) * 256 - 128;
      data[offset++] = (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * 256 - 128;
      data[offset++] = Math.sqrt(Number.isFinite(place.population) ? Math.max(place.population, 0) : 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    pointCount = places.length;
    bufferedPlaces = places;
  };

  const render = (places: Place[], size: Point, origin: Point, zoom: number, minimumRadius: number) => {
    setPlaces(places);
    const ratio = window.devicePixelRatio || 1;
    if (element.width !== size.x * ratio || element.height !== size.y * ratio) {
      element.width = size.x * ratio; element.height = size.y * ratio;
      element.style.width = `${size.x}px`; element.style.height = `${size.y}px`;
    }
    gl.viewport(0, 0, element.width, element.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(pointLocation); gl.vertexAttribPointer(pointLocation, 3, gl.FLOAT, false, 0, 0);
    const worldScale = 2 ** zoom;
    const growth = 2 ** Math.max(0, zoom - DOT_GROWTH_START_ZOOM + 1);
    gl.uniform2f(anchorLocation, 128 * worldScale - origin.x, 128 * worldScale - origin.y);
    gl.uniform2f(viewportLocation, size.x, size.y);
    gl.uniform1f(worldScaleLocation, worldScale);
    gl.uniform1f(radiusScaleLocation, growth * ratio);
    gl.uniform1f(minimumRadiusLocation, minimumRadius);
    gl.uniform1f(populationScaleLocation, POPULATION_RADIUS_SCALE);
    gl.uniform1f(maxSizeLocation, maxPointSize);
    gl.uniform1f(outlineLocation, 0.4 * ratio);
    gl.drawArrays(gl.POINTS, 0, pointCount);
  };

  return { render };
}

export default function Home() {
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const leaflet = useRef<typeof import('leaflet') | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Place[]>([]);
  const selectedRef = useRef<Place | null>(null);
  const labelsRef = useRef(false);
  const redrawMapRef = useRef<(() => void) | null>(null);
  const cityFocusInProgressRef = useRef(false);
  const tableScroll = useRef<HTMLDivElement>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [query, setQuery] = useState('');
  const [minPopulation, setMinPopulation] = useState(0);
  const [populationInput, setPopulationInput] = useState('0');
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tableOpen, setTableOpen] = useState(false);
  const [tableScrollTop, setTableScrollTop] = useState(0);
  const [tableViewportHeight, setTableViewportHeight] = useState(560);
  const [hoveredPlaceKey, setHoveredPlaceKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const deferredQuery = useDeferredValue(query);
  const allCountries = activeDatasetId === 'all';
  const activeDataset = datasets.find((dataset) => dataset.id === activeDatasetId) ?? null;
  const selectorDatasets = useMemo(() => [...datasets].sort((a, b) => a.country.localeCompare(b.country)), [datasets]);

  useEffect(() => {
    const cacheVersion = Date.now();
    fetch(`${BASE_PATH}/data/datasets.json?v=${cacheVersion}`, { cache: 'no-store' }).then((r) => r.json() as Promise<Dataset[]>).then(async (items) => {
      const available = (await Promise.all(items.map(async (dataset) => {
        const separator = dataset.file.includes('?') ? '&' : '?';
        const versionedDataset = { ...dataset, file: `${dataset.file}${separator}v=${cacheVersion}` };
        const response = await fetch(versionedDataset.file, { method: 'HEAD', cache: 'no-store' });
        return response.ok ? versionedDataset : null;
      }))).filter((dataset): dataset is Dataset => dataset !== null);
      setDatasets(available); setActiveDatasetId(available[0]?.id ?? '');
    }).catch(() => setError('The dataset catalog could not be loaded.'));
  }, []);

  useEffect(() => {
    if (!activeDatasetId || datasets.length === 0) return;
    // Loading a newly selected dataset resets the previous dataset's UI state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(''); setSelected(null);
    const targets = allCountries ? datasets : datasets.filter((dataset) => dataset.id === activeDatasetId);
    const worker = new Worker(`${BASE_PATH}/csv.worker.js`);
    worker.onmessage = (event: MessageEvent<{ places?: Place[]; error?: string }>) => {
      if (event.data.error) {
        setError(event.data.error); setLoading(false); return;
      }
      setPlaces(event.data.places ?? []);
      setLoading(false);
    };
    worker.onerror = () => { setError('This dataset could not be loaded.'); setLoading(false); };
    worker.postMessage({ datasets: targets.map(({ id, country, file }) => ({ id, country, file })) });
    return () => worker.terminate();
  }, [activeDatasetId, allCountries, datasets]);

  const filteredPlaces = useMemo(() => {
    const needle = normalizeSearchText(deferredQuery.trim());
    if (!needle && minPopulation === 0) return places;
    return places.filter((p) => {
      if ((Number.isFinite(p.population) ? p.population : 0) < minPopulation) return false;
      if (!needle) return true;
      const alternateNames = localizedNames(p).map((entry) => entry.value).join(' ');
      return normalizeSearchText(`${p.name} ${p.state} ${p.country} ${alternateNames} ${p.nicknames ?? ''}`).includes(needle);
    });
  }, [places, deferredQuery, minPopulation]);

  const tablePlaces = filteredPlaces;

  const mappedPlaces = useMemo(() => filteredPlaces.filter(hasCoordinates), [filteredPlaces]);

  useEffect(() => {
    pointsRef.current = mappedPlaces;
    redrawMapRef.current?.();
  }, [mappedPlaces]);

  useEffect(() => {
    selectedRef.current = selected;
    if (!cityFocusInProgressRef.current) redrawMapRef.current?.();
  }, [selected]);

  useEffect(() => {
    labelsRef.current = tableOpen;
    if (!cityFocusInProgressRef.current) redrawMapRef.current?.();
  }, [tableOpen]);

  useEffect(() => {
    if (!tableOpen || !tableScroll.current) return;
    const observer = new ResizeObserver(([entry]) => setTableViewportHeight(entry.contentRect.height));
    observer.observe(tableScroll.current);
    return () => observer.disconnect();
  }, [tableOpen]);

  useEffect(() => {
    if (!tableOpen || !selected) return;
    const selectedIndex = tablePlaces.findIndex((place) => placeKey(place) === placeKey(selected));
    if (selectedIndex < 0) return;
    requestAnimationFrame(() => {
      const target = Math.max(0, selectedIndex * TABLE_ROW_HEIGHT - tableViewportHeight / 2 + TABLE_ROW_HEIGHT / 2);
      tableScroll.current?.scrollTo({ top: target, behavior: 'smooth' });
    });
  }, [tableOpen, selected, tablePlaces, tableViewportHeight]);

  useEffect(() => {
    if (!mapElement.current || map.current) return;
    let cancelled = false;
    import('leaflet').then((L) => {
      if (cancelled || !mapElement.current) return;
      leaflet.current = L;
      const instance = L.map(mapElement.current, { center: [23.7, -102.4], zoom: 5, minZoom: 3, zoomControl: false });
      map.current = instance;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 18 }).addTo(instance);
      L.control.zoom({ position: 'bottomright' }).addTo(instance);
      const element = L.DomUtil.create('canvas', 'place-canvas') as HTMLCanvasElement;
      L.DomUtil.addClass(element, 'leaflet-zoom-animated');
      const labelElement = L.DomUtil.create('canvas', 'place-canvas label-canvas') as HTMLCanvasElement;
      L.DomUtil.addClass(labelElement, 'leaflet-zoom-animated');
      canvas.current = element;
      instance.getPanes().overlayPane.appendChild(element);
      instance.getPanes().overlayPane.appendChild(labelElement);
      let dotRenderer: ReturnType<typeof createDotRenderer> = null;
      try { dotRenderer = createDotRenderer(element); } catch { dotRenderer = null; }
      let canvasNorthWest = instance.containerPointToLatLng([0, 0]);
      let canvasCenter = instance.getCenter();
      let canvasZoom = instance.getZoom();
      let renderedPoints: { place: Place; x: number; y: number; radius: number }[] = [];

      const paint = (drawPoints: { place: Place; x: number; y: number; radius: number }[]) => {
        const size = instance.getSize();
        const ratio = window.devicePixelRatio || 1;
        if (labelElement.width !== size.x * ratio || labelElement.height !== size.y * ratio) {
          labelElement.width = size.x * ratio; labelElement.height = size.y * ratio;
          labelElement.style.width = `${size.x}px`; labelElement.style.height = `${size.y}px`;
        }
        const context = labelElement.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, size.x, size.y);
        if (!dotRenderer) {
          context.fillStyle = 'rgba(218, 107, 103, .6)';
          context.strokeStyle = 'rgba(0, 0, 0, .92)';
          context.lineWidth = .4;
          for (const point of drawPoints) {
            context.beginPath(); context.arc(point.x, point.y, point.radius, 0, Math.PI * 2); context.fill(); context.stroke();
          }
        }
        if (labelsRef.current) {
          const selectedId = selectedRef.current ? placeKey(selectedRef.current) : null;
          const zoom = instance.getZoom();
          const maxLabels = zoom < 7 ? 180 : zoom < 9 ? 320 : zoom < 11 ? 650 : 1400;
          const fontFamily = getComputedStyle(document.body).getPropertyValue('--font-roboto-condensed').trim() || 'Arial Narrow, sans-serif';
          context.font = `600 12px ${fontFamily}`;
          context.textBaseline = 'middle';
          context.textAlign = 'left';
          context.lineJoin = 'round';
          const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
          const candidates = [...drawPoints].sort((a, b) => {
            if (placeKey(a.place) === selectedId) return -1;
            if (placeKey(b.place) === selectedId) return 1;
            return (b.place.population || 0) - (a.place.population || 0);
          });
          let labelCount = 0;
          for (const point of candidates) {
            const isSelected = placeKey(point.place) === selectedId;
            if (!isSelected && labelCount >= maxLabels) continue;
            const text = point.place.name;
            const width = context.measureText(text).width;
            const x = point.x + point.radius + 4;
            const box = { left: x - 2, right: x + width + 2, top: point.y - 8, bottom: point.y + 8 };
            if (!isSelected && occupied.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
            context.lineWidth = 3.5;
            context.strokeStyle = '#fff';
            context.strokeText(text, x, point.y);
            context.fillStyle = isSelected ? '#da6b67' : '#000';
            context.fillText(text, x, point.y);
            occupied.push(box);
            labelCount += 1;
          }
        }
      };

      const redraw = () => {
        const size = instance.getSize();
        const zoom = instance.getZoom();
        const bucketSize = dotRenderer ? (zoom < 7 ? 4 : zoom < 10 ? 3 : zoom < 13 ? 2 : 0) : 0;
        const occupiedBuckets = bucketSize ? new Set<number>() : null;
        const viewBounds = instance.getBounds().pad(0.02);
        const south = viewBounds.getSouth();
        const north = viewBounds.getNorth();
        const west = viewBounds.getWest();
        const east = viewBounds.getEast();
        const crossesDateLine = west > east;
        canvasNorthWest = instance.containerPointToLatLng([0, 0]);
        canvasCenter = instance.getCenter();
        canvasZoom = zoom;
        const canvasPosition = instance.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(element, canvasPosition);
        L.DomUtil.setPosition(labelElement, canvasPosition);
        const projectedNorthWest = instance.project(canvasNorthWest, zoom);
        dotRenderer?.render(pointsRef.current, size, projectedNorthWest, zoom, NODE_RADIUS);
        renderedPoints = [];
        for (const place of pointsRef.current) {
          const latitude = place.latitude as number;
          const longitude = place.longitude as number;
          if (latitude < south || latitude > north) continue;
          if (crossesDateLine ? longitude < west && longitude > east : longitude < west || longitude > east) continue;
          const point = instance.latLngToContainerPoint([latitude, longitude]);
          if (point.x < -8 || point.y < -8 || point.x > size.x + 8 || point.y > size.y + 8) continue;
          if (occupiedBuckets) {
            const bucketX = Math.floor(point.x / bucketSize);
            const bucketY = Math.floor(point.y / bucketSize);
            const bucket = bucketY * Math.ceil(size.x / bucketSize + 4) + bucketX;
            if (occupiedBuckets.has(bucket)) continue;
            occupiedBuckets.add(bucket);
          }
          const radius = dotRadius(place.population, instance.getZoom(), NODE_RADIUS);
          renderedPoints.push({ place, x: point.x, y: point.y, radius });
          if (dotRenderer && renderedPoints.length >= MAX_RENDERED_POINTS) break;
        }
        paint(renderedPoints);
      };
      const findPlaceAt = (point: Point) => {
        let closest: Place | null = null;
        let closestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of renderedPoints) {
          const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
          const hitRadius = Math.max(10, candidate.radius + 4);
          if (distance <= hitRadius ** 2 && distance < closestDistance) {
            closestDistance = distance; closest = candidate.place;
          }
        }
        return closest;
      };
      const transformCanvas = (center: LatLng, zoom: number) => {
        const animatedMap = instance as LeafletMap & {
          _getNewPixelOrigin: (center: LatLng, zoom: number) => Point;
        };
        const scale = instance.getZoomScale(zoom, canvasZoom);
        const viewHalf = instance.getSize().multiplyBy(.5);
        const renderedCenterAtZoom = instance.project(canvasCenter, zoom);
        const offset = viewHalf.multiplyBy(-scale)
          .add(renderedCenterAtZoom)
          .subtract(animatedMap._getNewPixelOrigin(center, zoom));
        L.DomUtil.setTransform(element, offset, scale);
        L.DomUtil.setTransform(labelElement, offset, scale);
      };
      const animateZoom = (event: { zoom: number; center: LatLng }) => transformCanvas(event.center, event.zoom);
      let redrawFrame = 0;
      const scheduleRedraw = () => {
        cancelAnimationFrame(redrawFrame);
        redrawFrame = requestAnimationFrame(redraw);
      };
      const transformDuringCityFocus = () => {
        if (cityFocusInProgressRef.current) transformCanvas(instance.getCenter(), instance.getZoom());
      };
      redrawMapRef.current = scheduleRedraw;
      instance.on('moveend', () => {
        cityFocusInProgressRef.current = false;
        scheduleRedraw();
      });
      instance.on('resize', scheduleRedraw);
      instance.on('move', transformDuringCityFocus);
      instance.on('zoom', transformDuringCityFocus);
      instance.on('zoomanim', animateZoom);
      let pointerStart: { x: number; y: number } | null = null;
      let hoverFrame = 0;
      const container = instance.getContainer();
      container.addEventListener('pointerdown', (event) => { pointerStart = { x: event.clientX, y: event.clientY }; });
      container.addEventListener('pointermove', (event) => {
        cancelAnimationFrame(hoverFrame);
        hoverFrame = requestAnimationFrame(() => {
          if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6) { container.style.cursor = 'grabbing'; return; }
          const bounds = container.getBoundingClientRect();
          const place = findPlaceAt(L.point(event.clientX - bounds.left, event.clientY - bounds.top));
          container.style.cursor = place ? 'pointer' : 'grab';
        });
      });
      container.addEventListener('pointerup', (event) => {
        if (!pointerStart || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6) { pointerStart = null; return; }
        const bounds = container.getBoundingClientRect();
        const closest = findPlaceAt(L.point(event.clientX - bounds.left, event.clientY - bounds.top));
        if (closest) {
          event.preventDefault(); event.stopPropagation();
          setSelected(closest); setTableOpen(true);
          cityFocusInProgressRef.current = true;
          instance.flyTo(
            [closest.latitude as number, closest.longitude as number],
            Math.max(11, instance.getZoom()),
            { duration: .8, easeLinearity: .25 },
          );
        }
        pointerStart = null;
      });
      container.addEventListener('pointercancel', () => { pointerStart = null; });
      container.addEventListener('pointerleave', () => { container.style.cursor = 'grab'; });
      redraw();
    });
    return () => { cancelled = true; redrawMapRef.current = null; map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!map.current || !leaflet.current || !places.length) return;
    let south = 90; let north = -90; let west = 180; let east = -180;
    let coordinateCount = 0;
    for (const place of places) {
      if (!hasCoordinates(place)) continue;
      coordinateCount += 1;
      south = Math.min(south, place.latitude); north = Math.max(north, place.latitude);
      west = Math.min(west, place.longitude); east = Math.max(east, place.longitude);
    }
    if (!coordinateCount) return;
    const bounds = leaflet.current.latLngBounds([[south, west], [north, east]]);
    map.current.fitBounds(bounds, { padding: [34, 34], maxZoom: 6 });
    map.current.fire('move');
  }, [places]);

  function changeDataset(event: ChangeEvent<HTMLSelectElement>) {
    setQuery('');
    setActiveDatasetId(event.target.value);
  }
  function downloadShownCsv() {
    const localizedHeaders = [...new Set(filteredPlaces.flatMap((place) => Object.keys(place).filter((key) => /^name_[a-z]{2,3}(?:_[a-z0-9]+)?$/i.test(key))))].sort();
    const headers = ['code', 'name', ...localizedHeaders, 'state', 'country', 'latitude', 'longitude', 'population', 'nicknames'];
    const rows = filteredPlaces.map((place) => headers.map((header) => csvCell(place[header])).join(','));
    const blob = new Blob(['\uFEFF', headers.join(','), '\r\n', rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const name = allCountries ? 'all-countries' : (activeDataset?.country ?? 'places').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    anchor.href = url; anchor.download = `${name}-shown.csv`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function locate(place: Place) {
    if (!hasCoordinates(place)) return;
    setSelected(place); setTableOpen(true);
    cityFocusInProgressRef.current = true;
    map.current?.flyTo([place.latitude, place.longitude], 11, { duration: .8 });
  }
  function selectTablePlace(place: Place) {
    if (!hasCoordinates(place)) return;
    setSelected(place);
    cityFocusInProgressRef.current = true;
    map.current?.flyTo([place.latitude, place.longitude], Math.max(11, map.current.getZoom()), { duration: .8, easeLinearity: .25 });
  }
  function closeTable() {
    setTableOpen(false); setSelected(null); setHoveredPlaceKey(null);
  }
  function toggleTable() {
    if (tableOpen) { closeTable(); return; }
    setTableScrollTop(0); setTableOpen(true); setHoveredPlaceKey(null);
  }
  function handleTableScroll(event: UIEvent<HTMLDivElement>) { setTableScrollTop(event.currentTarget.scrollTop); }
  const featuredMatches = query ? filteredPlaces.slice(0, 5) : [];
  const populationTotal = useMemo(() => places.reduce((sum, p) => sum + (p.population || 0), 0), [places]);
  const tableStart = Math.max(0, Math.floor(tableScrollTop / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN);
  const tableEnd = Math.min(tablePlaces.length, Math.ceil((tableScrollTop + tableViewportHeight) / TABLE_ROW_HEIGHT) + TABLE_OVERSCAN);
  const visibleTablePlaces = tablePlaces.slice(tableStart, tableEnd);
  const years = allCountries ? [...new Set(datasets.map((dataset) => dataset.year))].sort((a, b) => b - a).join(', ') : String(activeDataset?.year ?? '');
  const countryTitle = allCountries ? 'All countries' : (activeDataset?.country ?? 'Dataset Atlas');
  const releaseLabel = activeDataset ? `${activeDataset.year} ${activeDataset.releaseType}` : '';
  const subdivisionHeading = allCountries ? 'Country / subdivision' : (activeDataset?.subdivisionLabel ?? 'Subdivision');

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="https://github.com/orasoupas" target="_blank" rel="noreferrer" aria-label="orasoupas on GitHub">
          <Image className="brand-mark" src={`${BASE_PATH}/atlas-icon.png`} width={36} height={36} alt="" priority /><span className="brand-title">Dataset Atlas</span>
        </a>
        <div className="dataset-picker"><label htmlFor="dataset">Dataset</label><select id="dataset" value={activeDatasetId} onChange={changeDataset}><option value="all">All countries (may run slowly)</option>{selectorDatasets.map((d) => <option key={d.id} value={d.id}>{d.country} · {d.sourceShort} · {d.year} {d.releaseType}{d.performanceNote ? ` (${d.performanceNote})` : ''}</option>)}</select></div>
      </header>

      <section className="map-stage" aria-label="Interactive map of dataset places">
        <div ref={mapElement} className="map" /><div className="map-wash" aria-hidden="true" />
        <aside className={`sidebar ${panelOpen ? 'open' : ''}`}>
          <button className="mobile-close" onClick={() => setPanelOpen(false)} aria-label="Close panel">×</button>
          <p className="eyebrow">{loading ? 'LOADING PLACES…' : allCountries ? `${format.format(places.length)} PLACES · MULTIPLE RELEASE TYPES` : `${releaseLabel.toLocaleUpperCase()} · ${format.format(places.length)} PLACES`}</p>
          <h1>{countryTitle}</h1>
          <div className="search-wrap"><span aria-hidden="true">⌕</span><input aria-label="Search places" placeholder="Search a city or subdivision" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button onClick={() => setQuery('')} aria-label="Clear search">×</button>}</div>
          {featuredMatches.length > 0 && <div className="results">{featuredMatches.map((p) => <button key={p.code} onClick={() => locate(p)} disabled={!hasCoordinates(p)}><span>{p.name}<small>{p.state}{!hasCoordinates(p) ? ' · Not mapped' : ''}</small></span><strong>{format.format(p.population)}</strong></button>)}</div>}
          <div className="filter-block">
            <div className="filter-heading"><label htmlFor="population">Minimum population</label><input className="population-value" type="number" inputMode="numeric" aria-label="Minimum population value" min="0" step="1" value={populationInput} onChange={(e) => { const raw = e.target.value; setPopulationInput(raw); const value = Number(raw); if (raw !== '' && Number.isFinite(value)) setMinPopulation(Math.max(0, Math.floor(value))); }} onBlur={() => { const value = Math.max(0, Math.floor(Number(populationInput) || 0)); setMinPopulation(value); setPopulationInput(String(value)); }} /></div>
            <input id="population" type="range" min="0" max="1000000" step="1000" value={Math.min(minPopulation, 1000000)} onChange={(e) => { const value = Number(e.target.value); setMinPopulation(value); setPopulationInput(String(value)); }} />
            <div className="range-labels"><span>All places</span><span>1M+</span></div>
          </div>
          <div className="stats-grid"><div><strong>{format.format(mappedPlaces.length)}</strong><span>Shown on map</span></div><div><strong>{populationTotal >= 1e6 ? `${(populationTotal / 1e6).toFixed(1)}M` : format.format(populationTotal)}</strong><span>Total population</span></div></div>
          <button className="table-button" aria-expanded={tableOpen} onClick={toggleTable}><span>{tableOpen ? 'Close table' : 'Browse table'}</span><strong>{tableOpen ? '×' : `${format.format(filteredPlaces.length)} rows →`}</strong></button>
          {activeDataset && <footer><span>Source: {activeDataset.source}</span></footer>}
        </aside>
        {tableOpen && <section className="table-panel" aria-label={`${countryTitle} place table`}>
          <header><div><p>{allCountries ? years : releaseLabel}</p><h2>{countryTitle}</h2></div><div className="table-header-actions"><button className="download-link" onClick={downloadShownCsv} disabled={filteredPlaces.length === 0}>Export shown CSV ↓</button><button className="table-close" onClick={closeTable} aria-label="Close place table">×</button></div></header>
          <div className="table-columns" role="row"><span>Place</span><span>{subdivisionHeading}</span><span>Population</span></div>
          <div className="table-scroll" ref={tableScroll} onScroll={handleTableScroll} role="table" aria-rowcount={tablePlaces.length}>
            <div className="table-spacer" style={{ height: tablePlaces.length * TABLE_ROW_HEIGHT }}>
              {visibleTablePlaces.map((place, index) => {
                const coordinates = hasCoordinates(place);
                const names = localizedNames(place);
                const rowIndex = tableStart + index;
                return <div
                  className={`place-row ${coordinates ? 'has-coordinates' : ''} ${hoveredPlaceKey !== null && hoveredPlaceKey === placeKey(place) ? 'is-hovered' : ''} ${selected && placeKey(selected) === placeKey(place) ? 'is-selected' : ''}`}
                  key={`${place.code || place.name}-${rowIndex}`}
                  role="row"
                  tabIndex={coordinates ? 0 : -1}
                  style={{ transform: `translateY(${rowIndex * TABLE_ROW_HEIGHT}px)` }}
                  onMouseEnter={() => coordinates && setHoveredPlaceKey(placeKey(place))}
                  onMouseLeave={() => setHoveredPlaceKey(null)}
                  onFocus={() => coordinates && setHoveredPlaceKey(placeKey(place))}
                  onBlur={() => setHoveredPlaceKey(null)}
                  onClick={() => selectTablePlace(place)}
                >
                  <span className="table-place" role="cell"><strong>{place.name}</strong>{names.length > 0 && <small dir="auto">{names.map((name) => name.value).join(' · ')}</small>}</span>
                  <span role="cell">{allCountries ? `${place.country}${place.state ? ` · ${place.state}` : ''}` : (place.state || '—')}</span>
                  <span role="cell">{Number.isFinite(place.population) ? format.format(place.population) : '—'}</span>
                </div>;
              })}
            </div>
          </div>
        </section>}
        {!panelOpen && <button className="open-panel" onClick={() => setPanelOpen(true)}>Explore dataset</button>}
        {error && <div className="error-message">{error}</div>}
      </section>
    </main>
  );
}
