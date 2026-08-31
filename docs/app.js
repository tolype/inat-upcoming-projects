const place = document.getElementById("place");
const suggestions = document.getElementById("suggestions");
const go = document.getElementById("go");
const status = document.getElementById("status");
const results = document.getElementById("results");
const backRow = document.getElementById("back-row");
const backBtn = document.getElementById("back");
const cardsEl = document.getElementById("cards");

// --- Config -----------------------------------------------------------

// Query Rate guidance: ~1 request/second
const INAT_MIN_INTERVAL_MS = 1000;
const DEBOUNCE_MS = 250;
const PER_PAGE = 30;
// 600 candidates per load / "Load more" click
// (rate is fixed by inatThrottle regardless of batch size)
const PAGES_PER_BATCH = 20;
// exclude dated projects with total duration longer than a year (370 days)
const MAX_DURATION_MS = 370 * 24 * 60 * 60 * 1000;
// iNaturalist's page/per_page pagination errors past 10,000 results for a given
// search (see API recommended practices) — stop ourselves before hitting that,
// rather than erroring on the request that would cross it.
const API_RESULT_CAP = 10000;

// --- Small UI helpers ---------------------------------------------------

function setStatus(msg, isError) {
  status.textContent = msg;
  status.style.color = isError ? "var(--text-danger)" : "var(--text-secondary)";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function showPlacePicker() {
  backRow.style.display = "none";
  setPickerEnabled(true);
}

function hideSuggestions() {
  suggestions.style.display = "none";
  suggestions.innerHTML = "";
}

function setPickerEnabled(enabled) {
  go.disabled = !enabled;
  place.disabled = !enabled;
}

function setLoading(isLoading) {
  setPickerEnabled(!isLoading);
  const loadMoreBtn = document.getElementById("load-more");
  if (loadMoreBtn) loadMoreBtn.disabled = isLoading;
}

// --- iNaturalist API ------------------------------------------------------

let lastInatRequestAt = 0;
async function inatThrottle() {
  const wait = INAT_MIN_INTERVAL_MS - (Date.now() - lastInatRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastInatRequestAt = Date.now();
}

// Shared place lookup — used by both live autocomplete dropdown and Enter/button fallback flow
async function fetchPlaces(q) {
  const url = new URL("https://api.inaturalist.org/v2/places");
  url.searchParams.set("fields", "id,display_name");
  url.searchParams.set("q", q);

  await inatThrottle();
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return data.results || [];
}

async function fetchProjects(placeId, page) {
  const url = new URL("https://api.inaturalist.org/v2/projects");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("per_page", PER_PAGE);
  url.searchParams.set("page", page);
  url.searchParams.set("order_by", "created");
  url.searchParams.set("fields", "all");

  await inatThrottle();
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// search_parameters is the field that reliably carries d1/d2 (rule_preferences
// doesn't, even with fields=all — only holds quality_grade on the search endpoint).
// Returns a timestamp (number), not a Date — hence "Timestamp" in the name.
function getProjectDateTimestamp(project, field) {
  const params = project.search_parameters || [];
  const match = params.find((r) => r.field === field);
  if (!match || !match.value) return null;
  const ts = Date.parse(match.value);
  return Number.isNaN(ts) ? null : ts;
}

function getCurrentOrUpcomingProjects(projects) {
  const now = Date.now();
  return projects
    .map((p) => ({
      ...p,
      d1: getProjectDateTimestamp(p, "d1"),
      d2: getProjectDateTimestamp(p, "d2"),
    }))
    .filter((p) => {
      const isCurrentOrUpcoming =
        (p.d1 !== null && p.d1 >= now) || (p.d2 !== null && p.d2 >= now);
      if (!isCurrentOrUpcoming) return false;
      // Exclude long-running, multi-year campaigns in favor of discrete/annual
      // events — only applies when we have both bounds to measure a span from.
      return !(
        p.d1 !== null &&
        p.d2 !== null &&
        p.d2 - p.d1 >= MAX_DURATION_MS
      );
    });
}

// --- Place picking --------------------------------------------------------

function selectPlace(id, name) {
  place.value = name;
  hideSuggestions();
  searchProjects(id, name);
}

// Live typeahead: debounced so we're not firing a request per keystroke.
let debounceTimer = null;
let autocompleteToken = 0; // guards against a slow earlier response overwriting a newer one

place.addEventListener("input", () => {
  const q = place.value.trim();
  clearTimeout(debounceTimer);
  if (q.length < 3) {
    hideSuggestions();
    return;
  }
  debounceTimer = setTimeout(() => fetchSuggestions(q), DEBOUNCE_MS);
});

async function fetchSuggestions(q) {
  const token = ++autocompleteToken;
  try {
    const matches = (await fetchPlaces(q)).slice(0, 8);
    if (token !== autocompleteToken) return; // a newer keystroke has since fired a new request
    if (!matches.length) {
      hideSuggestions();
      return;
    }
    suggestions.innerHTML = matches
      .map(
        (p) =>
          '<button type="button" data-id="' +
          p.id +
          '" data-name="' +
          escapeHtml(p.display_name) +
          '">' +
          escapeHtml(p.display_name) +
          "</button>",
      )
      .join("");
    suggestions.style.display = "block";
  } catch (e) {
    // Typeahead failures fail silently — the Enter/button flow still works as a fallback.
    console.error("Autocomplete failed", e);
  }
}

// One delegated listener instead of one per suggestion button.
suggestions.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  selectPlace(btn.dataset.id, btn.dataset.name);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".place-wrap")) hideSuggestions();
});
place.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideSuggestions();
  if (e.key === "Enter") {
    hideSuggestions();
    findPlaces();
  }
});

// Step 1: find candidate iNat places matching what was typed (Enter/button fallback).
async function findPlaces() {
  hideSuggestions();
  const q = place.value.trim();
  results.innerHTML = "";
  if (!q) {
    setStatus("Enter a place first.", true);
    return;
  }

  setLoading(true);
  try {
    setStatus('Looking up "' + q + '"...');
    let matches;
    try {
      matches = (await fetchPlaces(q)).slice(0, 8);
    } catch (e) {
      throw new Error("Place lookup failed: " + e.message);
    }

    if (!matches.length) {
      setStatus('No places found for "' + q + '". Try a different name.', true);
      return;
    }

    setStatus("Which place did you mean?");
    results.innerHTML = matches
      .map(
        (p) =>
          '<button class="place-option" data-id="' +
          p.id +
          '" data-name="' +
          escapeHtml(p.display_name) +
          '">' +
          escapeHtml(p.display_name) +
          "</button>",
      )
      .join("");
  } catch (err) {
    setStatus("Error: " + err.message, true);
    console.error(err);
  } finally {
    setLoading(false);
  }
}

// One delegated listener on #results handles place-option picks, the
// "no results" state has nothing clickable, and the load-more button (added
// dynamically inside loadBatch) is also covered here — no re-binding needed
// on every render.
results.addEventListener("click", (e) => {
  const placeBtn = e.target.closest(".place-option");
  if (placeBtn) {
    selectPlace(placeBtn.dataset.id, placeBtn.dataset.name);
    return;
  }
  if (e.target.closest("#load-more")) {
    loadBatch();
  }
});

// --- Project search ---------------------------------------------------

function renderCard(p) {
  const name = escapeHtml(p.title || p.name || "Untitled project");
  const url =
    "https://www.inaturalist.org/projects/" +
    encodeURIComponent(p.slug || p.id);
  const imgSrc = p.header_image_url || p.icon || "";
  const img = imgSrc
    ? '<img src="' +
      escapeHtml(imgSrc) +
      '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
    : "";

  let desc = "";
  if (p.description) {
    const truncated =
      p.description.length > 160
        ? p.description.slice(0, 160) + "..."
        : p.description;
    desc = '<p class="desc">' + escapeHtml(truncated) + "</p>";
  }

  let dateLine = "";
  if (p.d1) {
    let range = "Starts " + formatDate(p.d1);
    if (p.d2) range = formatDate(p.d1) + " – " + formatDate(p.d2);
    dateLine = '<p class="desc" style="margin-top: 2px;">' + range + "</p>";
  } else if (p.d2) {
    dateLine =
      '<p class="desc" style="margin-top: 2px;">Ends ' +
      formatDate(p.d2) +
      "</p>";
  }

  return `
    <a class="card" href="${url}" target="_blank" rel="noopener">
      ${img}
      <div class="card-body">
        <p class="name">${name}</p>
        ${dateLine}
        ${desc}
      </div>
    </a>
  `;
}

// Batch-search state, carried across "Load more" clicks for the current place.
// totalResults is null until the first page response tells us what it is.
let searchState = null; // { placeId, placeName, nextPage, totalResults, checked, matchedCount }

// Step 2: given a chosen iNat place_id, find current/upcoming dated projects in it.
async function searchProjects(placeId, placeName) {
  searchState = {
    placeId,
    placeName,
    nextPage: 1,
    totalResults: null,
    checked: 0,
    matchedCount: 0,
  };
  cardsEl.innerHTML = "";
  results.innerHTML = "";
  backRow.style.display = "block";
  await loadBatch();
}

function hasMoreToCheck(s) {
  return (
    s.checked < API_RESULT_CAP &&
    (s.totalResults === null || s.checked < s.totalResults)
  );
}

async function loadBatch() {
  if (!searchState) return;
  setLoading(true);

  try {
    let pagesThisBatch = 0;
    let hitApiCap = false;

    while (pagesThisBatch < PAGES_PER_BATCH && hasMoreToCheck(searchState)) {
      setStatus(
        "Searching projects in " +
          searchState.placeName +
          "... " +
          searchState.matchedCount +
          " found so far (checked " +
          searchState.checked +
          " of " +
          (searchState.totalResults === null ? "?" : searchState.totalResults) +
          ")",
      );

      let projData;
      try {
        projData = await fetchProjects(
          searchState.placeId,
          searchState.nextPage,
        );
      } catch (e) {
        throw new Error("iNaturalist request failed: " + e.message);
      }

      const pageResults = projData.results || [];
      searchState.totalResults =
        projData.total_results ?? searchState.checked + pageResults.length;
      searchState.checked += pageResults.length;
      searchState.nextPage++;
      pagesThisBatch++;
      if (
        searchState.checked >= API_RESULT_CAP &&
        searchState.totalResults !== null &&
        searchState.checked < searchState.totalResults
      )
        hitApiCap = true;

      const newlyMatched = getCurrentOrUpcomingProjects(pageResults);
      if (newlyMatched.length) {
        // Sort within this page only, then append immediately — renders progressively
        // as pages arrive instead of making someone wait out the whole batch, and never
        // reshuffles cards already on screen from earlier pages or earlier batches.
        newlyMatched.sort(
          (a, b) => (a.d1 ?? a.d2 ?? Infinity) - (b.d1 ?? b.d2 ?? Infinity),
        );
        cardsEl.insertAdjacentHTML(
          "beforeend",
          newlyMatched.map(renderCard).join(""),
        );
        searchState.matchedCount += newlyMatched.length;
      }

      if (!pageResults.length) break; // no more pages
    }

    const hasMore = hasMoreToCheck(searchState);
    const capNote = hitApiCap
      ? " (iNaturalist caps search results at " +
        API_RESULT_CAP.toLocaleString() +
        " — stopping here.)"
      : "";
    setStatus(
      searchState.matchedCount +
        " current/upcoming project" +
        (searchState.matchedCount === 1 ? "" : "s") +
        " found in " +
        searchState.placeName +
        " (checked " +
        searchState.checked +
        " of " +
        searchState.totalResults +
        " projects there)." +
        capNote,
    );

    const noResultsHtml =
      searchState.matchedCount === 0
        ? '<p style="color: var(--text-secondary); font-size: 14px;">No current or upcoming projects found in ' +
          escapeHtml(searchState.placeName) +
          (hasMore ? " yet — try loading more." : ".") +
          "</p>"
        : "";

    const loadMoreHtml = hasMore
      ? '<button id="load-more" style="display:block; margin: 1rem auto 0;">Load more (checked ' +
        searchState.checked +
        " of " +
        searchState.totalResults +
        ")</button>"
      : "";

    results.innerHTML = noResultsHtml + loadMoreHtml;
  } catch (err) {
    setStatus("Error: " + err.message, true);
    console.error(err);
  } finally {
    setLoading(false);
  }
}

// --- Wiring -----------------------------------------------------------

go.addEventListener("click", findPlaces);
backBtn.addEventListener("click", () => {
  searchState = null;
  cardsEl.innerHTML = "";
  results.innerHTML = "";
  setStatus("");
  showPlacePicker();
});
