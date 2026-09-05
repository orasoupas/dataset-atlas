'use client';

import { ChangeEvent, UIEvent, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import type { LatLng, Map as LeafletMap, Point } from 'leaflet';

type Dataset = { id: string; title: string; country: string; year: number; source: string; sourceShort: string; file: string; description: string; subdivisionLabel: string };
type CsvValue = string | number | boolean | null | undefined;
type Place = { code: string; name: string; state: string; country: string; latitude: number | null; longitude: number | null; population: number; state_capital?: number; national_capital?: number; datasetId?: string; [key: string]: CsvValue };
const format = new Intl.NumberFormat('en-US');
const TABLE_ROW_HEIGHT = 50;
const TABLE_OVERSCAN = 8;
const MIN_SELECT_ZOOM = 5;
const DOT_GROWTH_START_ZOOM = 15;
const NODE_RADIUS = 4;
const POPULATION_RADIUS_SCALE = 0.006;
const dotRadius = (population: number, zoom: number) => {
  const safePopulation = Number.isFinite(population) ? Math.max(population, 0) : 0;
  const baseRadius = NODE_RADIUS + POPULATION_RADIUS_SCALE * Math.sqrt(safePopulation);
  const growthSteps = Math.max(0, zoom - DOT_GROWTH_START_ZOOM + 1);
  const mapScale = 2 ** growthSteps;
  return baseRadius * mapScale;
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

export default function Home() {
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const leaflet = useRef<typeof import('leaflet') | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Place[]>([]);
  const selectedRef = useRef<Place | null>(null);
  const labelsRef = useRef(false);
  const tableScroll = useRef<HTMLDivElement>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [query, setQuery] = useState('');
  const [minPopulation, setMinPopulation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tableOpen, setTableOpen] = useState(false);
  const [tableScrollTop, setTableScrollTop] = useState(0);
  const [tableViewportHeight, setTableViewportHeight] = useState(560);
  const [hoveredPlaceKey, setHoveredPlaceKey] = useState<string | null>(null);
  const [labelsVisible, setLabelsVisible] = useState(false);
  const [error, setError] = useState('');
  const allCountries = activeDatasetId === 'all';
  const activeDataset = datasets.find((dataset) => dataset.id === activeDatasetId) ?? null;

  useEffect(() => {
    fetch('/data/datasets.json').then((r) => r.json()).then(async (items: Dataset[]) => {
      const available = (await Promise.all(items.map(async (dataset) => {
        const response = await fetch(dataset.file, { method: 'HEAD' });
        return response.ok ? dataset : null;
      }))).filter((dataset): dataset is Dataset => dataset !== null);
      setDatasets(available); setActiveDatasetId(available[0]?.id ?? '');
    }).catch(() => setError('The dataset catalog could not be loaded.'));
  }, []);

  useEffect(() => {
    if (!activeDatasetId || datasets.length === 0) return;
    setLoading(true); setError(''); setSelected(null);
    const targets = allCountries ? datasets : datasets.filter((dataset) => dataset.id === activeDatasetId);
    Promise.all(targets.map(async (dataset) => {
      const csv = await fetch(dataset.file).then((response) => response.text());
      const result = Papa.parse<Place>(csv, { header: true, dynamicTyping: true, skipEmptyLines: true });
      return result.data.map((place) => ({ ...place, datasetId: dataset.id }));
    })).then((rows) => {
      setPlaces(rows.flat());
      setLoading(false);
    }).catch(() => { setError('This dataset could not be loaded.'); setLoading(false); });
  }, [activeDatasetId, allCountries, datasets]);

  const filteredPlaces = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return places.filter((p) => {
      if ((Number.isFinite(p.population) ? p.population : 0) < minPopulation) return false;
      if (!needle) return true;
      const alternateNames = localizedNames(p).map((entry) => entry.value).join(' ');
      return `${p.name} ${p.state} ${p.country} ${alternateNames}`.toLocaleLowerCase().includes(needle);
    });
  }, [places, query, minPopulation]);

  const tablePlaces = useMemo(() => [...filteredPlaces].sort((a, b) => {
    const populationA = Number.isFinite(a.population) ? a.population : -1;
    const populationB = Number.isFinite(b.population) ? b.population : -1;
    return populationB - populationA;
  }), [filteredPlaces]);

  const mappedPlaces = useMemo(() => filteredPlaces.filter(hasCoordinates), [filteredPlaces]);

  useEffect(() => {
    pointsRef.current = mappedPlaces;
    map.current?.fire('moveend');
  }, [mappedPlaces]);

  useEffect(() => {
    selectedRef.current = selected;
    map.current?.fire('moveend');
  }, [selected]);

  useEffect(() => {
    labelsRef.current = labelsVisible;
    map.current?.fire('moveend');
  }, [labelsVisible]);

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
      canvas.current = element;
      instance.getPanes().overlayPane.appendChild(element);
      let canvasNorthWest = instance.containerPointToLatLng([0, 0]);
      let renderedPoints: { place: Place; x: number; y: number; radius: number }[] = [];

      const paint = (drawPoints: { place: Place; x: number; y: number; radius: number }[]) => {
        const size = instance.getSize();
        const ratio = window.devicePixelRatio || 1;
        if (element.width !== size.x * ratio || element.height !== size.y * ratio) {
          element.width = size.x * ratio; element.height = size.y * ratio;
          element.style.width = `${size.x}px`; element.style.height = `${size.y}px`;
        }
        const context = element.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, size.x, size.y);
        context.fillStyle = 'rgba(213, 66, 38, .6)';
        context.strokeStyle = 'rgba(0, 0, 0, .92)';
        context.lineWidth = .4;
        for (const point of drawPoints) {
          context.beginPath(); context.arc(point.x, point.y, point.radius, 0, Math.PI * 2); context.fill(); context.stroke();
        }
        if (labelsRef.current) {
          const selectedId = selectedRef.current ? placeKey(selectedRef.current) : null;
          const zoom = instance.getZoom();
          const maxLabels = zoom < 7 ? 60 : zoom < 9 ? 180 : zoom < 11 ? 500 : 1400;
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
            context.fillStyle = isSelected ? '#d54226' : '#000';
            context.fillText(text, x, point.y);
            occupied.push(box);
            labelCount += 1;
          }
        }
      };

      const redraw = () => {
        const size = instance.getSize();
        const viewBounds = instance.getBounds().pad(0.02);
        const south = viewBounds.getSouth();
        const north = viewBounds.getNorth();
        const west = viewBounds.getWest();
        const east = viewBounds.getEast();
        const crossesDateLine = west > east;
        canvasNorthWest = instance.containerPointToLatLng([0, 0]);
        L.DomUtil.setTransform(element, instance.containerPointToLayerPoint([0, 0]), 1);
        renderedPoints = [];
        for (const place of pointsRef.current) {
          const latitude = place.latitude as number;
          const longitude = place.longitude as number;
          if (latitude < south || latitude > north) continue;
          if (crossesDateLine ? longitude < west && longitude > east : longitude < west || longitude > east) continue;
          const point = instance.latLngToContainerPoint([place.latitude, place.longitude]);
          if (point.x < -8 || point.y < -8 || point.x > size.x + 8 || point.y > size.y + 8) continue;
          const radius = dotRadius(place.population, instance.getZoom());
          renderedPoints.push({ place, x: point.x, y: point.y, radius });
        }
        paint(renderedPoints);
      };
      const findPlaceAt = (point: Point) => {
        if (instance.getZoom() < MIN_SELECT_ZOOM) return null;
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
      const animateZoom = (event: { zoom: number; center: LatLng }) => {
        const animatedMap = instance as LeafletMap & {
          _latLngToNewLayerPoint: (latlng: LatLng, zoom: number, center: LatLng) => Point;
        };
        const offset = animatedMap._latLngToNewLayerPoint(canvasNorthWest, event.zoom, event.center);
        L.DomUtil.setTransform(element, offset, instance.getZoomScale(event.zoom));
      };
      let redrawFrame = 0;
      const scheduleRedraw = () => {
        cancelAnimationFrame(redrawFrame);
        redrawFrame = requestAnimationFrame(redraw);
      };
      instance.on('moveend resize', scheduleRedraw);
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
        }
        pointerStart = null;
      });
      container.addEventListener('pointercancel', () => { pointerStart = null; });
      container.addEventListener('pointerleave', () => { container.style.cursor = 'grab'; });
      redraw();
    });
    return () => { cancelled = true; map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const placesWithCoordinates = places.filter(hasCoordinates);
    if (!map.current || !leaflet.current || !placesWithCoordinates.length) return;
    const bounds = leaflet.current.latLngBounds(placesWithCoordinates.map((p) => [p.latitude, p.longitude] as [number, number]));
    map.current.fitBounds(bounds, { padding: [34, 34], maxZoom: 6 });
    map.current.fire('move');
  }, [places]);

  function changeDataset(event: ChangeEvent<HTMLSelectElement>) {
    setActiveDatasetId(event.target.value);
  }
  function locate(place: Place) {
    if (!hasCoordinates(place)) return;
    setSelected(place); setTableOpen(true); map.current?.flyTo([place.latitude, place.longitude], 11, { duration: .8 });
  }
  function selectTablePlace(place: Place) {
    if (!hasCoordinates(place)) return;
    setSelected(place);
    map.current?.flyTo([place.latitude, place.longitude], Math.max(11, map.current.getZoom()), { duration: .45 });
  }
  function handleTableScroll(event: UIEvent<HTMLDivElement>) { setTableScrollTop(event.currentTarget.scrollTop); }
  const featuredMatches = query ? filteredPlaces.slice(0, 5) : [];
  const populationTotal = useMemo(() => places.reduce((sum, p) => sum + (p.population || 0), 0), [places]);
  const tableStart = Math.max(0, Math.floor(tableScrollTop / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN);
  const tableEnd = Math.min(tablePlaces.length, Math.ceil((tableScrollTop + tableViewportHeight) / TABLE_ROW_HEIGHT) + TABLE_OVERSCAN);
  const visibleTablePlaces = tablePlaces.slice(tableStart, tableEnd);
  const years = allCountries ? [...new Set(datasets.map((dataset) => dataset.year))].sort((a, b) => b - a).join(', ') : String(activeDataset?.year ?? '');
  const countryTitle = allCountries ? 'All countries' : (activeDataset?.country ?? 'Dataset');
  const subdivisionHeading = allCountries ? 'Country / subdivision' : (activeDataset?.subdivisionLabel ?? 'Subdivision');

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="https://cityquiz.io" target="_blank" rel="noreferrer" aria-label="CityQuiz.io">
          <img className="brand-mark" src="/cityquiz.png" alt="" /><span><strong>CityQuiz</strong><small>Dataset Atlas</small></span>
        </a>
        <div className="dataset-picker"><label htmlFor="dataset">Dataset</label><select id="dataset" value={activeDatasetId} onChange={changeDataset}><option value="all">All countries</option>{datasets.map((d) => <option key={d.id} value={d.id}>{d.country} · {d.sourceShort} {d.year}</option>)}</select></div>
        <div className="status-chip"><i /> {loading ? 'Loading places…' : `${format.format(places.length)} places`}</div>
      </header>

      <section className="map-stage" aria-label="Interactive map of dataset places">
        <div ref={mapElement} className="map" /><div className="map-wash" aria-hidden="true" />
        <aside className={`sidebar ${panelOpen ? 'open' : ''}`}>
          <button className="mobile-close" onClick={() => setPanelOpen(false)} aria-label="Close panel">×</button>
          <p className="eyebrow">{loading ? 'LOADING PLACES…' : `${format.format(places.length)} PLACES · ${years}`}</p>
          <h1>{countryTitle}</h1>
          <p className="intro">{allCountries ? 'Explore every available country dataset together, or choose one country for its full release details.' : activeDataset?.description}</p>
          <div className="search-wrap"><span aria-hidden="true">⌕</span><input aria-label="Search places" placeholder="Search a city or subdivision" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button onClick={() => setQuery('')} aria-label="Clear search">×</button>}</div>
          {featuredMatches.length > 0 && <div className="results">{featuredMatches.map((p) => <button key={p.code} onClick={() => locate(p)} disabled={!hasCoordinates(p)}><span>{p.name}<small>{p.state}{!hasCoordinates(p) ? ' · Not mapped' : ''}</small></span><strong>{format.format(p.population)}</strong></button>)}</div>}
          <div className="filter-block"><div><label htmlFor="population">Minimum population</label><strong>{format.format(minPopulation)}</strong></div><input id="population" type="range" min="0" max="1000000" step="10000" value={minPopulation} onChange={(e) => setMinPopulation(Number(e.target.value))} /><div className="range-labels"><span>All places</span><span>1M+</span></div></div>
          <div className="stats-grid"><div><strong>{format.format(mappedPlaces.length)}</strong><span>Shown on map</span></div><div><strong>{populationTotal >= 1e6 ? `${(populationTotal / 1e6).toFixed(1)}M` : format.format(populationTotal)}</strong><span>Total population</span></div></div>
          <button className="table-button" aria-expanded={tableOpen} onClick={() => { if (!tableOpen) setTableScrollTop(0); setTableOpen(!tableOpen); setHoveredPlaceKey(null); }}><span>{tableOpen ? 'Close table' : 'Browse table'}</span><strong>{tableOpen ? '×' : `${format.format(filteredPlaces.length)} rows →`}</strong></button>
          <label className="label-toggle"><span><strong>Map labels</strong><small>Show place names</small></span><input type="checkbox" checked={labelsVisible} onChange={(event) => setLabelsVisible(event.target.checked)} /><i aria-hidden="true" /></label>
          <p className="hint"><span>↗</span> Click any dot to inspect a place.</p>
          <footer><span>{allCountries ? 'Multiple data sources' : `Source: ${activeDataset?.source}`}</span></footer>
        </aside>
        {tableOpen && <section className="table-panel" aria-label={`${countryTitle} place table`}>
          <header><div><p>{years}</p><h2>{countryTitle}</h2></div><div className="table-header-actions">{allCountries ? <details className="download-menu"><summary>Download CSV ↓</summary><div>{datasets.map((dataset) => <a key={dataset.id} href={dataset.file} download={`${dataset.country.toLocaleLowerCase()}.csv`}>{dataset.country} · {dataset.sourceShort} {dataset.year}</a>)}</div></details> : activeDataset && <a className="download-link" href={activeDataset.file} download={`${activeDataset.country.toLocaleLowerCase()}.csv`}>Download CSV ↓</a>}<button onClick={() => { setTableOpen(false); setHoveredPlaceKey(null); }} aria-label="Close place table">×</button></div></header>
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
