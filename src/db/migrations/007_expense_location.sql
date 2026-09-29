ALTER TABLE expense ADD COLUMN location_lat REAL CHECK (location_lat BETWEEN -90 AND 90);
ALTER TABLE expense ADD COLUMN location_lng REAL CHECK (
  (location_lng IS NULL OR location_lng BETWEEN -180 AND 180) AND ((location_lat IS NULL) = (location_lng IS NULL))
);
ALTER TABLE expense ADD COLUMN place_name TEXT;
ALTER TABLE expense ADD COLUMN location_source TEXT CHECK (location_source IN ('photo', 'device'));

-- Shared reverse-geocoding cache: no group or person identifiers.
CREATE TABLE place_cache (
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  name TEXT,
  looked_up_at INTEGER NOT NULL,
  PRIMARY KEY (lat, lng)
);
