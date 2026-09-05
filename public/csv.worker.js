importScripts('/vendor/papaparse.min.js');

const coordinate = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const numeric = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const loadDataset = (dataset) => new Promise((resolve, reject) => {
  const places = [];

  Papa.parse(dataset.file, {
    download: true,
    header: true,
    dynamicTyping: true,
    skipEmptyLines: 'greedy',
    step: ({ data }) => {
      const place = {
        code: String(data.code ?? ''),
        name: String(data.name ?? ''),
        state: String(data.state ?? ''),
        country: String(data.country ?? dataset.country),
        latitude: coordinate(data.latitude),
        longitude: coordinate(data.longitude),
        population: numeric(data.population),
        nicknames: String(data.nicknames ?? ''),
        datasetId: dataset.id,
      };

      for (const [key, value] of Object.entries(data)) {
        if (/^name_[a-z]{2,3}(?:_[a-z0-9]+)?$/i.test(key) && typeof value === 'string' && value.trim()) {
          place[key] = value;
        }
      }
      places.push(place);
    },
    complete: () => resolve(places),
    error: (error) => reject(error),
  });
});

self.onmessage = async (event) => {
  try {
    const groups = await Promise.all(event.data.datasets.map(loadDataset));
    const places = groups.flat();
    places.sort((a, b) => b.population - a.population);
    self.postMessage({ places });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'The dataset could not be loaded.' });
  }
};
