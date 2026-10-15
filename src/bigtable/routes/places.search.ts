import { NextRequest, NextResponse } from "../next-shim.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";

type GooglePlace = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  internationalPhoneNumber?: string;
  websiteUri?: string;
  primaryType?: string;
};

type GooglePlacesResponse = {
  places?: GooglePlace[];
};

type SearchVenue = {
  key: string;
  name: string;
  address: string;
  phone?: string | undefined;
  logoUrl?: string | undefined;
  latitude: number;
  longitude: number;
  sourceClass: string;
  sourceType: string;
};

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const LOGO_DEV_PUBLISHABLE_KEY =
  process.env.LOGO_DEV_PUBLISHABLE_KEY ?? process.env.EXPO_PUBLIC_LOGO_DEV_PUBLISHABLE_KEY;

const DEFAULT_RADIUS_MILES = 5;
const MAX_RADIUS_MILES = 31; // ~50 km, Google Places locationBias.circle maximum
const MILES_TO_METERS = 1609.344;
const MIN_SEARCH_LENGTH = 3;

// Maps Google Places primaryType values to OSM-style sourceType values that the
// client's markerIconForVenue and isLikelyFoodVenue functions already understand.
const GOOGLE_TYPE_TO_SOURCE_TYPE: Record<string, string> = {
  restaurant: "restaurant",
  fast_food_restaurant: "fast_food",
  cafe: "cafe",
  coffee_shop: "cafe",
  bar: "bar",
  pub: "pub",
  bakery: "bakery",
  food_court: "food_court",
  ice_cream_shop: "ice_cream",
  meal_delivery: "restaurant",
  meal_takeaway: "fast_food",
  pizza_restaurant: "restaurant",
  hamburger_restaurant: "fast_food",
  sandwich_shop: "restaurant",
  ramen_restaurant: "restaurant",
  sushi_restaurant: "restaurant",
  steak_house: "restaurant",
  seafood_restaurant: "restaurant",
  mexican_restaurant: "restaurant",
  chinese_restaurant: "restaurant",
  italian_restaurant: "restaurant",
  japanese_restaurant: "restaurant",
  thai_restaurant: "restaurant",
  indian_restaurant: "restaurant",
  korean_restaurant: "restaurant",
  mediterranean_restaurant: "restaurant",
  greek_restaurant: "restaurant",
  vietnamese_restaurant: "restaurant",
  american_restaurant: "restaurant",
  brunch_restaurant: "restaurant",
  breakfast_restaurant: "restaurant",
  barbecue_restaurant: "restaurant",
  diner: "restaurant",
};

const normalizeSearchText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

const clampRadiusMiles = (value: number) => {
  if (!Number.isFinite(value)) return DEFAULT_RADIUS_MILES;
  return Math.max(1, Math.min(MAX_RADIUS_MILES, value));
};

const domainFromWebsite = (rawWebsite?: string) => {
  if (!rawWebsite?.trim()) return undefined;
  const withScheme = /^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`;
  try {
    const hostname = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
    return hostname || undefined;
  } catch {
    return undefined;
  }
};

const logoUrlForDomain = (domain?: string) => {
  if (!domain) return undefined;
  const base = `https://img.logo.dev/${encodeURIComponent(domain)}?format=png&size=64`;
  return LOGO_DEV_PUBLISHABLE_KEY ? `${base}&token=${encodeURIComponent(LOGO_DEV_PUBLISHABLE_KEY)}` : base;
};

const logoUrlForName = (name: string) => {
  const base = `https://img.logo.dev/name/${encodeURIComponent(name)}?format=png&size=64`;
  return LOGO_DEV_PUBLISHABLE_KEY ? `${base}&token=${encodeURIComponent(LOGO_DEV_PUBLISHABLE_KEY)}` : base;
};

const fetchGooglePlaces = async (
  query: string,
  latitude: number,
  longitude: number,
  radiusMeters: number,
): Promise<GooglePlace[]> => {
  if (!GOOGLE_PLACES_API_KEY) {
    throw Object.assign(new Error("Places API not configured"), { status: 503 });
  }

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.internationalPhoneNumber,places.websiteUri,places.primaryType",
    },
    body: JSON.stringify({
      textQuery: query,
      locationBias: {
        circle: {
          center: { latitude, longitude },
          radius: Math.round(radiusMeters),
        },
      },
      maxResultCount: 20,
      languageCode: "en",
    }),
    cache: "no-store",
  });

  if (response.status === 429) {
    throw Object.assign(new Error("rate_limited"), { status: 429 });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`places_error_${response.status}`), { status: 502 });
  }

  const json = (await response.json()) as GooglePlacesResponse;
  return json.places ?? [];
};

const placesToVenues = (places: GooglePlace[]): SearchVenue[] => {
  return places.flatMap((place): SearchVenue[] => {
    const name = place.displayName?.text?.trim();
    if (!name || !place.location) return [];

    const { latitude, longitude } = place.location;
    const domain = domainFromWebsite(place.websiteUri);
    const logoUrl = domain ? logoUrlForDomain(domain) : logoUrlForName(name);
    const sourceType = GOOGLE_TYPE_TO_SOURCE_TYPE[place.primaryType ?? ""] ?? "restaurant";

    return [
      {
        key: place.id,
        name,
        address: place.formattedAddress?.trim() ?? "",
        phone: place.internationalPhoneNumber?.trim() || undefined,
        logoUrl,
        latitude,
        longitude,
        sourceClass: "amenity",
        sourceType,
      },
    ];
  });
};

export async function GET(request: NextRequest) {
  // Google Places is billable, so search needs a signed-in user (it was public in the old API).
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = normalizeSearchText(url.searchParams.get("q") ?? "");

  if (query.length < MIN_SEARCH_LENGTH) {
    return NextResponse.json({ error: `q must be at least ${MIN_SEARCH_LENGTH} characters` }, { status: 400 });
  }

  const latitude = Number(url.searchParams.get("latitude") ?? "");
  const longitude = Number(url.searchParams.get("longitude") ?? "");
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return NextResponse.json({ error: "latitude and longitude are required" }, { status: 400 });
  }

  const radiusMiles = clampRadiusMiles(Number(url.searchParams.get("radiusMiles") ?? `${DEFAULT_RADIUS_MILES}`));
  const radiusMeters = radiusMiles * MILES_TO_METERS;

  let places: GooglePlace[];
  try {
    places = await fetchGooglePlaces(query, latitude, longitude, radiusMeters);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 502;
    const message =
      status === 429 ? "Search provider rate limited" :
      status === 503 ? "Search is not configured" :
      "Search provider failed";
    return NextResponse.json({ error: message }, { status });
  }

  const results = placesToVenues(places);
  return NextResponse.json({ results });
}
