
import { useEffect, useRef, useState } from "react";
import "./prototype.css";
import { fetchRiskAreas } from "./services/riskApi";
import ReportFire from "./components/ReportFire";
import { REPORTS_ENABLED } from "./services/reportApi";
import { fetchDetections } from "./services/detectionApi";
import { describeLoadError } from "./utils/loadError";
import DataFreshness from "./components/DataFreshness";
import {
  classificationLabel,
  detectionStyle,
  detectionSummary,
  formatConfidence,
  formatCoordinates,
  formatDetectionTime,
} from "./utils/detectionFormat";
import {
  FACTOR_LABELS as factorLabels,
  areaBounds,
  missingInputNames,
  riskAreaStyle,
  validRiskScore,
  riskColor,
  riskState,
  riskStatusText,
} from "./utils/riskFormat";
import { MapContainer, TileLayer, CircleMarker, Circle, Popup, Tooltip, useMap } from "react-leaflet";
import { RISK_ZONE_RADIUS_M, riskZoneStyle } from "./utils/riskZone";
import "leaflet/dist/leaflet.css";
import { explainFactors } from "./utils/riskExplanation";
import { sortAreasByRisk } from "./utils/riskFormat";
import RiskLegend from "./components/RiskLegend";

const factorUnits = {
  temperature_c: "°C",
  relative_humidity_pct: "%",
  wind_speed_kmh: "km/h",
  precipitation_mm: "mm",
  slope_deg: "°",
};

// Zoom the map to the monitored areas once they load (#68 areas span Canada).
function FitToAreas({ areas }) {
  const map = useMap();
  const points = areaBounds(areas);
  const key = points.map((p) => p.join(",")).join(";");

  useEffect(() => {
    if (points.length > 0) {
      map.fitBounds(points, { padding: [30, 30], maxZoom: 8 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);

  return null;
}

// Pan when an area selected from the list is outside the visible map.
function FocusSelected({ area }) {
  const map = useMap();
  useEffect(() => {
    if (!area || !Number.isFinite(area.latitude) || !Number.isFinite(area.longitude)) return;
    const point = [area.latitude, area.longitude];
    // Always focus a selected search result; preserve the existing pan-only test map.
    if (typeof map.flyTo === "function") {
      map.flyTo(point, Math.max(map.getZoom?.() ?? 6, 10), { animate: true, duration: 0.9 });
    } else if (map.getBounds && !map.getBounds().contains(point)) {
      map.panTo(point);
    }
  }, [map, area]);
  return null;
}

function RefreshMapLayout({ active }) {
  const map = useMap();
  useEffect(() => {
    if (active) {
      map.invalidateSize?.();
      const frame = requestAnimationFrame(() => map.invalidateSize?.());
      return () => cancelAnimationFrame(frame);
    }
  }, [map, active]);
  return null;
}

function App() {
  const [riskAreas, setRiskAreas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedArea, setSelectedArea] = useState(null);
  const [showZones, setShowZones] = useState(true);
  const [search, setSearch] = useState("");
  const [showFullDetails, setShowFullDetails] = useState(false);
  const [view, setView] = useState("dashboard");
  const [page, setPage] = useState("explore");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const detailsRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    function closeMenu(event) {
      if (event.type === "keydown" && event.key === "Escape") setMenuOpen(false);
      if (event.type === "pointerdown" && !menuRef.current?.contains(event.target)) setMenuOpen(false);
    }
    document.addEventListener("keydown", closeMenu);
    document.addEventListener("pointerdown", closeMenu);
    return () => {
      document.removeEventListener("keydown", closeMenu);
      document.removeEventListener("pointerdown", closeMenu);
    };
  }, [menuOpen]);
  const [detectionResult, setDetectionResult] = useState(null);
  const [detectionError, setDetectionError] = useState(null);
  const [reporting, setReporting] = useState(false); // #51 Report a Fire panel
  const [detectionLoading, setDetectionLoading] = useState(true);
  // #25/#26: warnings from the API (e.g. fire history unavailable), plus
  // counters that re-run a load when the user presses "Try again".
  const [warnings, setWarnings] = useState([]);
  const [riskAttempt, setRiskAttempt] = useState(0);
  const [detectionAttempt, setDetectionAttempt] = useState(0);

  // #18: detections load separately from risk areas, so if one request fails
  // the other still shows (see #4, reliable handling of failures).
  useEffect(() => {
    let active = true;

    async function loadDetections() {
      setDetectionLoading(true);
      try {
        const result = await fetchDetections();

        if (!active) return;

        setDetectionResult(result);
        setDetectionError(null);
      } catch (err) {
        if (!active) return;

        // Show an error, never invented detections.
        setDetectionResult(null);
        setDetectionError(describeLoadError(err, "Unable to load wildfire detections."));
      } finally {
        if (active) setDetectionLoading(false);
      }
    }

    loadDetections();

    return () => {
      active = false;
    };
  }, [detectionAttempt]);

  useEffect(() => {
    let active = true;

    async function loadRiskAreas() {
      try {
        const result = await fetchRiskAreas();

        if (!active) return;

        setRiskAreas(result.data);
        setWarnings(Array.isArray(result.warnings) ? result.warnings : []);
        setError(null);
      } catch (err) {
        if (!active) return;

        setRiskAreas([]);
        setWarnings([]);
        setError(describeLoadError(err, "Unable to load wildfire risk data."));
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadRiskAreas();

    return () => {
      active = false;
    };
  }, [riskAttempt]);

  function retryRiskAreas() {
    setLoading(true);
    setError(null);
    setRiskAttempt((n) => n + 1);
  }

  function retryDetections() {
    setDetectionLoading(true);
    setDetectionError(null);
    setDetectionAttempt((n) => n + 1);
  }

  const factors = selectedArea?.environmental_factors ?? {};
  const filteredAreas = sortAreasByRisk(riskAreas)
    .filter((area) => (area.name ?? `Area ${area.id}`).toLowerCase().includes(search.trim().toLowerCase()));
  function selectArea(area) {
    setPage("explore");
    setSelectedArea(area);
    setShowFullDetails(false);
    setView("information");
    if (window.matchMedia?.("(max-width: 860px)").matches) {
      requestAnimationFrame(() => {
        detailsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        detailsRef.current?.focus?.({ preventScroll: true });
      });
    }
  }

  return (
    <div className={`ew-app ew-view-${view}`}>
      <header className="ew-header">
        <div className="ew-header-left">
        {page === "explore" && view !== "dashboard" && <button className="ew-nav-back" type="button" onClick={() => { if(view === "risk") {setView("information");setShowFullDetails(false);} else {setView("dashboard");setSelectedArea(null);} }}>← Back</button>}
        <button type="button" className="ew-brand ew-brand-button" aria-label="Go to EmberWatch home" onClick={() => {setPage("home");setView("dashboard");setMenuOpen(false);}}>
        <span className="ew-brand-icon" aria-hidden="true">🔥</span>
        <span>EMBER<span className="ew-brand-accent">WATCH</span>
        </span>
        </button>
        </div>
        <nav className="ew-top-nav" aria-label="Main navigation">
          <button type="button" aria-current={page === "home" ? "page" : undefined} onClick={() => setPage("home")}>Home</button>
          <button type="button" aria-current={page === "explore" ? "page" : undefined} onClick={() => setPage("explore")}>Explore map</button>
          <button type="button" aria-current={page === "learn" ? "page" : undefined} onClick={() => setPage("learn")}>Understand risk</button>
        </nav>
        <div className="ew-menu-wrap" ref={menuRef}>
          <button type="button" className="ew-menu-toggle" aria-label="Map settings" aria-expanded={menuOpen} aria-controls="ew-navigation" onClick={() => setMenuOpen((open) => !open)}>
            <span aria-hidden="true">⚙</span><span>Map settings</span>
          </button>
          {menuOpen && <nav id="ew-navigation" className="ew-navigation" aria-label="Map settings">
            <strong>Map preferences</strong>
            <p className="ew-settings-note">Risk-zone visibility is controlled from the map toolbar.</p>
            <button type="button" onClick={() => { setSelectedArea(null); setShowFullDetails(false); setView("dashboard"); setMenuOpen(false); }}>Reset map selection</button>
            <button type="button" onClick={() => { setReporting(true); setMenuOpen(false); }}>Report a Fire {REPORTS_ENABLED ? "" : "(preview)"}</button>
            <p>EmberWatch is an educational risk explorer, not an emergency alert service.</p>
          </nav>}
        </div>
        </header>
      <main className="ew-main">
      {page === "home" && <section className="ew-home" aria-label="EmberWatch home">
        <div className="ew-home-hero"><span className="ew-eyebrow">CANADIAN WILDFIRE DATA · EXPLAINED</span><h1>See the signals.<br /><em>Understand the risk.</em></h1><p>Explore satellite fire observations and environmental risk assessments in one interactive map. Designed to make complex wildfire data easier to understand.</p><div className="ew-home-actions"><button type="button" onClick={() => setPage("explore")}>Explore the map <span aria-hidden="true">→</span></button><button type="button" className="ew-secondary-action" onClick={() => setPage("learn")}>How it works</button></div><p className="ew-home-caution">Educational prototype · Not an emergency alert or evacuation service</p></div>
        <div className="ew-home-preview" aria-label="Explore features"><div className="ew-home-orbit"><span>🔥</span></div><p className="ew-overline">THE EMBERWATCH EXPERIENCE</p><h2>From observations to insight.</h2><div className="ew-feature-tiles"><button type="button" onClick={() => setPage("explore")}><strong>01 · Explore</strong><span>Search monitored regions and zoom to their risk assessments.</span><span aria-hidden="true">↗</span></button><button type="button" onClick={() => setPage("explore")}><strong>02 · Discover</strong><span>Inspect satellite hotspots, timestamps and confidence.</span><span aria-hidden="true">↗</span></button><button type="button" onClick={() => setPage("learn")}><strong>03 · Understand</strong><span>Learn what the scores mean and where data is missing.</span><span aria-hidden="true">↗</span></button></div></div>
      </section>}
      {page === "learn" && <section className="ew-learn" aria-label="Understanding wildfire risk"><button type="button" className="ew-text-back" onClick={() => setPage("home")}>← Back to home</button><span className="ew-eyebrow">DATA, NOT PREDICTIONS</span><h1>Know what you’re looking at.</h1><p className="ew-learn-intro">EmberWatch combines environmental observations and satellite detections. These are different kinds of information, with different limitations.</p><div className="ew-learn-grid"><article><span>01 / AREA RISK</span><h2>Environmental risk</h2><p>A provisional 0–100 model score derived from available weather, terrain and nearby detection history. It is not a forecast of where a fire will spread.</p></article><article><span>02 / SATELLITE SIGNAL</span><h2>Detection confidence</h2><p>Confidence describes an individual satellite hotspot observation, not the overall wildfire risk of a region. Hotspots are not necessarily confirmed wildfires.</p></article><article><span>03 / DATA QUALITY</span><h2>Freshness matters</h2><p>Older observations may not reflect current conditions. Check the dates, missing inputs and warnings before interpreting any risk assessment.</p></article></div><button type="button" className="ew-primary-action" onClick={() => setPage("explore")}>Explore monitored areas →</button><p className="ew-home-caution">For emergencies, follow official local authorities and emergency services.</p></section>}
      <div className={page === "explore" ? "ew-explore-page" : "ew-page-hidden"}>
        <div className="ew-page-heading">
        <div>
        <span className="ew-eyebrow"><span className="ew-live-ember" aria-hidden="true" /> WILDFIRE INTELLIGENCE · CANADA</span>
        <h1>
        {view === "dashboard" ? "Wildfire intelligence, in focus." : "Area assessment"}
        </h1>
        <p>
        {view === "dashboard" ? "Explore satellite detections and environmental risk across monitored locations." : "Risk assessment and environmental conditions"}
        </p>
        </div>
        </div>

      <div className="ew-dashboard-tools">
      {/* #51: public fire reports. Not an emergency service. */}
      {reporting && <ReportFire onClose={() => setReporting(false)} />}

      </div>

      {loading && (
        <p>Loading wildfire risk data...</p>
      )}

      {error && (
        <p role="alert" style={{ color: "red" }}>
          Risk data unavailable: {error}{" "}
          <button type="button" aria-label="Try loading risk data again" onClick={retryRiskAreas}>
            Try again
          </button>
        </p>
      )}

      {warnings.map((warning) => (
        <p key={warning.code} role="status" className="ew-warning">
          Notice: {warning.message}
        </p>
      ))}

      {!loading && !error && riskAreas.length === 0 && (
        <p>No monitored areas were returned by the backend.</p>
      )}

      {detectionLoading && (
        <p role="status">Loading wildfire detections...</p>
      )}

      {detectionError && (
        <p role="alert" style={{ color: "red" }}>
          Detections unavailable: {detectionError}{" "}
          <button type="button" aria-label="Try loading detections again" onClick={retryDetections}>
            Try again
          </button>
        </p>
      )}

      <DataFreshness areas={riskAreas} detections={detectionResult?.detections} />

      {detectionResult && !detectionLoading && (
        <div className="ew-data-summary" role="status">
          <span>{detectionSummary(detectionResult)}</span>
          {detectionResult.detections.length === 0 && <span>No wildfire detections available for the latest observations.</span>}
        </div>
      )}

      <div className="ew-workspace">
        <div className="ew-ember-field" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /></div>
        <div className="ew-map-column"><div className="ew-map-title"><span className="ew-map-title-dot" /> MAP EXPLORER <span className="ew-map-title-caption">MONITORED REGIONS</span></div><div className="ew-map-frame">
          <MapContainer
            center={[45.4, -77.5]}
            zoom={7}
            style={{ height: "100%", width: "100%" }}
          >
            <RefreshMapLayout active={page === "explore"} />
            <FocusSelected area={selectedArea} />
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            <FitToAreas areas={riskAreas} />

            {/* Draw non-interactive risk zones below clickable area and detection markers. */}
            {showZones && riskAreas
              .filter((area) => Number.isFinite(area.latitude) && Number.isFinite(area.longitude))
              .map((area) => (
                <Circle
                  key={`zone-${area.id}`}
                  center={[area.latitude, area.longitude]}
                  radius={RISK_ZONE_RADIUS_M}
                  pathOptions={riskZoneStyle(area)}
                  interactive={false}
                />
              ))}

            {riskAreas.map((area) => {
              // Pixel-sized markers stay visible at country-wide zoom levels.
              const { radius, ...pathOptions } = riskAreaStyle(area, selectedArea?.id === area.id);

              return (
                <CircleMarker
                  key={area.id}
                  center={[area.latitude, area.longitude]}
                  radius={radius}
                  pathOptions={pathOptions}
                  eventHandlers={{
                    click: () => { 
                      selectArea(area);
                    },
                  }}
                >
                  <Tooltip permanent={selectedArea?.id === area.id} direction="top" offset={[0, -12]} className={selectedArea?.id === area.id ? "ew-selected-tooltip" : ""}>
                    <strong>{area.name ?? `Area ${area.id}`}</strong>{selectedArea?.id === area.id ? <><br />Risk: {riskStatusText(area)}{validRiskScore(area) ? ` · ${area.risk_score.toFixed(1)}/100` : ""}</> : `: ${riskStatusText(area)}`}
                  </Tooltip>
               </CircleMarker>  
             );
           })}
           
          {detectionResult?.detections.map((detection) => {
            const { radius, ...pathOptions } = detectionStyle(detection);

            return (
              <CircleMarker
                key={`detection-${detection.id}`}
                center={[detection.latitude, detection.longitude]}
                radius={radius}
                pathOptions={pathOptions}
              >
                <Popup>
                  <strong>{classificationLabel(detection)}</strong>
                  <p>
                    Location: {formatCoordinates(detection.latitude, detection.longitude)}
                    <br />
                    Detected: {formatDetectionTime(detection.timestamp)}
                    <br />
                    Confidence: {formatConfidence(detection.confidence)}
                  </p>

                  {!detection.meets_threshold && (
                    <p>
                      Below the {detectionResult.threshold}% confidence
                      threshold. Treat with caution.
                    </p>
                  )}
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer></div>
        <div className="ew-map-controls"><label className="ew-zone-toggle">
          <input
            type="checkbox"
            checked={showZones}
            onChange={(event) => setShowZones(event.target.checked)}
          />{" "}
          Show 50 km risk zones
        </label>
        <details className="ew-legend-disclosure"><summary>Map legend</summary><RiskLegend /></details>
        <details className="ew-map-help"><summary>About this map</summary><p aria-label="Risk zone legend">Shaded risk zones represent the 50 km modeled footprint, not predicted fire spread.</p><p aria-label="Detection marker legend">Detection markers: solid red = meets confidence threshold; dashed grey = low confidence. Detection confidence reflects the observation, not the environmental wildfire risk score.</p><p>Shaded 50 km circles represent modeled area risk, not predicted fire spread. Dashed outlines indicate incomplete inputs. Red detection markers meet the satellite confidence threshold; grey markers do not. Detection confidence is not the same as wildfire risk.</p></details>
        </div>
      </div>
      
        <aside className="ew-side-panel">
          <div className="ew-panel-top">
          <div className="ew-locations-heading"><h2>Search & explore</h2><span className="ew-section-meta">{riskAreas.length} areas</span></div>
          <label className="ew-search-label" htmlFor="ew-area-search">Search monitored areas</label>
          <input id="ew-area-search" type="search" placeholder="Search city or monitored area..." value={search} onChange={(event) => { setSearch(event.target.value); if (view !== "dashboard") setView("dashboard"); }} onKeyDown={(event) => { if (event.key === "Enter" && filteredAreas.length > 0) selectArea(filteredAreas[0]); }} />
          {search.trim() && <p className="ew-search-count">{filteredAreas.length} matching monitored {filteredAreas.length === 1 ? "area" : "areas"} · Press Enter to zoom to first result</p>}
          <nav className="ew-area-list" aria-label="Monitored areas">
          {filteredAreas.map((area) => <button type="button" aria-pressed={selectedArea?.id === area.id} className={`ew-area-row ${selectedArea?.id === area.id ? "is-selected" : ""}`} key={area.id} onClick={() => selectArea(area)}>
          <span className="ew-area-name">
          {area.name ?? `Area ${area.id}`}
          </span>
          <span className={`ew-risk-tag ew-risk-${(validRiskScore(area) ? area.risk_level : "unavailable").toLowerCase()}`}>
          {validRiskScore(area) ? area.risk_level : "N/A"}
          </span>
          <span aria-hidden="true">›</span>
          </button>)}{filteredAreas.length === 0 && <p className="ew-empty-search">No matching monitored areas.</p>}
          </nav>
          <p className="ew-search-footnote">Risk assessments are available for monitored areas only; searching does not generate new risk predictions.</p>
          </div>
          <div ref={detailsRef} tabIndex={-1} className="ew-detail-panel" aria-label="Area details">
          {!selectedArea ? (
            <>
              <h2>Area Details</h2>
              <p>Click a colored circle on the map to view its risk assessment and environmental data.</p>
            </>
          ) : (
            <>
              <div className="ew-detail-heading"><div><span className="ew-overline">AREA ASSESSMENT</span><h2>{selectedArea.name ?? `Area ${selectedArea.id}`}</h2></div><button type="button" className="ew-back-button" onClick={() => { setSelectedArea(null); setShowFullDetails(false); setView("dashboard"); }}>← Back</button></div>

              {riskState(selectedArea) === "incomplete" && (
                <p role="status">
                  Some inputs are missing. This risk assessment is incomplete.
                </p>
              )}

              {riskState(selectedArea) === "unavailable" && (
                <p role="status">
                  {selectedArea.processing_error
                    ? "The risk score could not be calculated for this area. Try again later."
                    : "Not enough input data to calculate a risk score for this area."}
                </p>
              )}

              <div className="ew-metric-grid">
                <div className="ew-metric">
                <span>Risk level</span>
                <strong style={{color: riskColor(selectedArea)}}>
                {validRiskScore(selectedArea) ? selectedArea.risk_level : "Unavailable"}
                </strong>
                </div>
                <div className="ew-metric">
                <span>Risk score</span>
                <strong>
                {validRiskScore(selectedArea) ? `${selectedArea.risk_score.toFixed(1)} / 100` : "Unavailable"}
                </strong>
                </div>
                </div>
                {validRiskScore(selectedArea) && (
                  <div className="ew-score-bar" aria-hidden="true"><span style={{ width: `${selectedArea.risk_score}%`, background: riskColor(selectedArea) }} /></div>
                )}
                <hr />

              <div className="ew-assessment-summary">
                {selectedArea.observed_at && <p>Weather observed {formatDetectionTime(selectedArea.observed_at)}</p>}
                <p>{selectedArea.is_complete ? "All modeled inputs available" : `Partial assessment · ${Math.round((selectedArea.coverage ?? 0) * 100)}% input coverage`}</p>
              </div>
              <details className="ew-factor-disclosure">
                <summary>Environmental conditions</summary>
                <div className="ew-factor-list">
                  {Object.entries(factorLabels).map(([key, label]) => {
                    const value = factors[key];
                    const available = value !== null && value !== undefined && Number.isFinite(value);
                    return <div className="ew-factor-row" key={key}><span>{label}:</span><strong>{available ? `${value}${factorUnits[key] ? ` ${factorUnits[key]}` : ""}` : "Unavailable"}</strong></div>;
                  })}
                </div>
                {selectedArea.missing_inputs?.length > 0 && <p>Missing inputs: {missingInputNames(selectedArea).join(", ")}</p>}
                <p>These environmental factors contribute to an experimental risk estimate, not a confirmed fire.</p>
              </details>

              <button type="button" className="ew-details-button" onClick={() => {setShowFullDetails((v) => !v);setView((v) => v === "risk" ? "information" : "risk");}} aria-expanded={showFullDetails}>{showFullDetails ? "← Back to Fire Information" : "View Risk Details →"}</button>
              <div className={showFullDetails ? "ew-expanded-details" : "ew-collapsed-details"}><h3>How the risk estimate is calculated</h3>
              <ul aria-label="Risk factor explanations">
                {explainFactors(selectedArea).map(({ key, weight, score, explanation }) => (
                  <li key={key}>
                    <strong>{factorLabels[key]} ({Math.round(weight * 100)}% base weight): </strong>
                    {score === null ? "Unavailable" : `${score.toFixed(1)} / 100`}. {explanation}
                  </li>
                ))}
              </ul>
              <p>Model: {selectedArea.model_version ?? "Unavailable"}. Factor scores and weights are provisional; this is not a validated real-time fire forecast.</p>

              </div><button type="button" className="ew-clear-selection" onClick={() => { setSelectedArea(null); setShowFullDetails(false); setView("dashboard"); }}>Clear selection</button>
            </>
          )}
        </div></aside>
      </div></div></main>
    </div>
  );
}

export default App;
