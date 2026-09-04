'use client';

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import type { Map as LeafletMap } from 'leaflet';

type Dataset = { id: string; title: string; country: string; year: number; source: string; file: string; description: string };
type Place = { code: string; name: string; state: string; country: string; latitude: number; longitude: number; population: number; state_capital?: number; national_capital?: number };
const format = new Intl.NumberFormat('en-US');

export default function Home() {
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const leaflet = useRef<typeof import('leaflet') | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Place[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeDataset, setActiveDataset] = useState<Dataset | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [query, setQuery] = useState('');
  const [minPopulation, setMinPopulation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/data/datasets.json').then((r) => r.json()).then((items: Dataset[]) => {
      setDatasets(items); setActiveDataset(items[0]);
    }).catch(() => setError('The dataset catalog could not be loaded.'));
  }, []);

  useEffect(() => {
    if (!activeDataset) return;
    setLoading(true); setError(''); setSelected(null);
    fetch(activeDataset.file).then((r) => r.text()).then((csv) => {
      const result = Papa.parse<Place>(csv, { header: true, dynamicTyping: true, skipEmptyLines: true });
      setPlaces(result.data.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude)));
      setLoading(false);
    }).catch(() => { setError('This dataset could not be loaded.'); setLoading(false); });
  }, [activeDataset]);

  const filteredPlaces = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return places.filter((p) => p.population >= minPopulation && (!needle || `${p.name} ${p.state} ${p.country}`.toLocaleLowerCase().includes(needle)));
  }, [places, query, minPopulation]);

  useEffect(() => {
    pointsRef.current = filteredPlaces;
    map.current?.fire('move');
  }, [filteredPlaces]);

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
      canvas.current = element;
      instance.getPanes().overlayPane.appendChild(element);

      const redraw = () => {
        const size = instance.getSize();
        const ratio = window.devicePixelRatio || 1;
        element.width = size.x * ratio; element.height = size.y * ratio;
        element.style.width = `${size.x}px`; element.style.height = `${size.y}px`;
        L.DomUtil.setPosition(element, instance.containerPointToLayerPoint([0, 0]));
        const context = element.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, size.x, size.y);
        context.fillStyle = 'rgba(255, 83, 76, .72)';
        context.strokeStyle = 'rgba(126, 28, 28, .35)';
        const zoom = instance.getZoom();
        for (const place of pointsRef.current) {
          const point = instance.latLngToContainerPoint([place.latitude, place.longitude]);
          if (point.x < -8 || point.y < -8 || point.x > size.x + 8 || point.y > size.y + 8) continue;
          const radius = Math.max(1.35, Math.min(6, Math.log10(Math.max(place.population, 10)) - 2.8)) + Math.max(0, zoom - 7) * .12;
          context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fill();
          if (radius > 3.2) context.stroke();
        }
      };
      instance.on('move zoom resize', redraw);
      instance.on('click', (event) => {
        let closest: Place | null = null; let closestDistance = 100;
        for (const place of pointsRef.current) {
          const point = instance.latLngToContainerPoint([place.latitude, place.longitude]);
          const distance = (point.x - event.containerPoint.x) ** 2 + (point.y - event.containerPoint.y) ** 2;
          if (distance < closestDistance) { closestDistance = distance; closest = place; }
        }
        if (closest) { setSelected(closest); setPanelOpen(true); }
      });
      redraw();
    });
    return () => { cancelled = true; map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!map.current || !leaflet.current || !places.length) return;
    const bounds = leaflet.current.latLngBounds(places.map((p) => [p.latitude, p.longitude] as [number, number]));
    map.current.fitBounds(bounds, { padding: [34, 34], maxZoom: 6 });
    map.current.fire('move');
  }, [places]);

  function changeDataset(event: ChangeEvent<HTMLSelectElement>) {
    const next = datasets.find((d) => d.id === event.target.value); if (next) setActiveDataset(next);
  }
  function locate(place: Place) { setSelected(place); setPanelOpen(true); map.current?.flyTo([place.latitude, place.longitude], 11, { duration: .8 }); }
  const featuredMatches = query ? filteredPlaces.slice(0, 5) : [];
  const populationTotal = useMemo(() => places.reduce((sum, p) => sum + (p.population || 0), 0), [places]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="https://cityquiz.io" target="_blank" rel="noreferrer" aria-label="CityQuiz.io">
          <span className="brand-mark">CQ</span><span><strong>CityQuiz</strong><small>Dataset Atlas</small></span>
        </a>
        <div className="dataset-picker"><label htmlFor="dataset">Dataset</label><select id="dataset" value={activeDataset?.id ?? ''} onChange={changeDataset}>{datasets.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></div>
        <div className="status-chip"><i /> {loading ? 'Loading places…' : `${format.format(places.length)} places`}</div>
      </header>

      <section className="map-stage" aria-label="Interactive map of dataset places">
        <div ref={mapElement} className="map" /><div className="map-wash" aria-hidden="true" />
        <aside className={`sidebar ${panelOpen ? 'open' : ''}`}>
          <button className="mobile-close" onClick={() => setPanelOpen(false)} aria-label="Close panel">×</button>
          <p className="eyebrow">COMMUNITY DATASET · {activeDataset?.year}</p>
          <h1>{activeDataset?.country ?? 'Dataset'} in detail.</h1>
          <p className="intro">{activeDataset?.description}</p>
          <div className="search-wrap"><span aria-hidden="true">⌕</span><input aria-label="Search places" placeholder="Search a city or subdivision" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button onClick={() => setQuery('')} aria-label="Clear search">×</button>}</div>
          {featuredMatches.length > 0 && <div className="results">{featuredMatches.map((p) => <button key={p.code} onClick={() => locate(p)}><span>{p.name}<small>{p.state}</small></span><strong>{format.format(p.population)}</strong></button>)}</div>}
          <div className="filter-block"><div><label htmlFor="population">Minimum population</label><strong>{format.format(minPopulation)}</strong></div><input id="population" type="range" min="0" max="1000000" step="10000" value={minPopulation} onChange={(e) => setMinPopulation(Number(e.target.value))} /><div className="range-labels"><span>All places</span><span>1M+</span></div></div>
          <div className="stats-grid"><div><strong>{format.format(filteredPlaces.length)}</strong><span>Shown on map</span></div><div><strong>{populationTotal >= 1e6 ? `${(populationTotal / 1e6).toFixed(1)}M` : format.format(populationTotal)}</strong><span>Total population</span></div></div>
          <p className="hint"><span>↗</span> Click any coral dot to inspect a place.</p>
          <footer><span>Source: {activeDataset?.source}</span><a href="https://cityquiz.io" target="_blank" rel="noreferrer">Visit CityQuiz ↗</a></footer>
        </aside>
        {!panelOpen && <button className="open-panel" onClick={() => setPanelOpen(true)}>Explore dataset</button>}
        {selected && <article className="place-card" aria-live="polite"><button onClick={() => setSelected(null)} aria-label="Close place details">×</button><p>PLACE DETAILS</p><h2>{selected.name}</h2><dl><div><dt>Subdivision</dt><dd>{selected.state || '—'}</dd></div><div><dt>Country</dt><dd>{selected.country}</dd></div><div><dt>Population</dt><dd>{format.format(selected.population)}</dd></div></dl>{(selected.national_capital === 1 || selected.state_capital === 1) && <span className="capital-badge">{selected.national_capital === 1 ? 'National capital' : 'State capital'}</span>}</article>}
        {error && <div className="error-message">{error}</div>}
      </section>
    </main>
  );
}
