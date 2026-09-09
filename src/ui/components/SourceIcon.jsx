import { SOURCE_ASSETS } from '../source-assets.js';
import { serviceLabel } from '../../engine/status.mjs';

// Bundled, unmodified assets from each service's own website.
// Provenance is recorded alongside the files in assets/sources/sources.json.
export default function SourceIcon({ service, size = 24, title }) {
  const label = title === undefined ? serviceLabel(service) : title;
  if (SOURCE_ASSETS[service]) {
    return <img className="src-icon" src={SOURCE_ASSETS[service]} width={size} height={size} alt={label} title={label || undefined} />;
  }
  return <span className="src-icon" role="img" aria-label={label} title={label} style={{ width: size, height: size }}>{serviceLabel(service).slice(0, 1)}</span>;
}
