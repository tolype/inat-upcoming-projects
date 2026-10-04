# Find upcoming iNaturalist projects by place

A tool to find upcoming iNaturalist projects in a place: bioblitzes, community events, etc.

Essentially a nice wrapper around a few different [iNaturalist API](https://api.inaturalist.org/v2/docs/) calls.

## Implementation notes

Relies on these iNat APIs:

- `GET /v2/projects`
- `GET /v2/places`

I aimed to follow the [iNat API Recommended Practices](https://www.inaturalist.org/pages/api+recommended+practices) (particularly on query rate).

### Uses places instead of coordinates

The `GET /projects` API has params to search by `place_id` and/or by latitude/longitude.
I ended up using `place_id` because, in testing, I found that many (but not all?) newer projects have a null `location`,
and `lat/lng` search filters appear to exclude any projects with a null `location`.

This led to the recommendation that users search using their county or region,
instead of a more specific location (city, park, etc.).
While searching a radius of a location's lat/long would be more flexible, the places approach works fine for now.

### Filtering

Currently filters results to projects that have a start and/or end date that is today or later.
Also filters out any events that have a total span of longer than a year,
with the intent of hiding long-term, less "eventlike" projects, while still including interesting results like yearlong capybara surveys.

Projects seemingly don't always store their date the same way: most use a `d1`/`d2` range,
but some one-day events use a single `observed_on` field instead.
And there might be other date conventions - we'll see!

### API quirks

`GET /projects` had some quirky behavior with `fields`.
Specifically, requesting field `search_parameters` (used for date filtering) returned a list of empty maps.
So instead, I'm requesting `all` fields, as this does populate `search_parameters` correctly.

### AI

Much of this was generated and refined using Claude.
I'm normally a backend developer, so please forgive any sins against the frontend.
