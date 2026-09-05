# CityQuiz Dataset Atlas

An interactive map and searchable table for population datasets used by [CityQuiz](https://cityquiz.io).

## Run locally

Install [Node.js 22](https://nodejs.org/) and [pnpm](https://pnpm.io/), then run:

```sh
pnpm install
pnpm dev
```

The local site is available at `http://localhost:3000`.

## Add or update a dataset

1. Place the country CSV in `public/data/` using a lowercase country filename, such as `argentina.csv`.
2. Add its metadata to `public/data/datasets.json`.
3. Commit and push the changes to `main`. GitHub Pages will rebuild the site automatically.

Dataset metadata includes the country, reference year, release type, full and shortened source names, subdivision label, and CSV path. Add `performanceNote` only when a dataset needs a warning in the selector.

The CSV should contain `code`, `name`, `state`, `country`, `latitude`, `longitude`, and `population`. It may also contain `nicknames` and localized-name columns such as `name_ar`.

## Deployment

The site is deployed to [datasets.cityquiz.io](https://datasets.cityquiz.io) through the workflow in `.github/workflows/deploy-pages.yml`.
