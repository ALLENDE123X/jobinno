/**
 * Curated location suggestions for the step 3 target locations chip picker
 * (JOB-313).
 *
 * Hardcoded on purpose, not scraped or fetched from an API. The three lists
 * below are the top 50 US metros by population, a top 20 set of
 * international tech destinations, and Remote as its own entry. A user can
 * still add any place not on this list by typing it and pressing enter, so
 * the list only has to be a useful starting point, not exhaustive.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

/** Remote is offered as its own suggestion, first in the combined list. */
export const REMOTE_SUGGESTION = "Remote";

/** Top 50 US metros by population, formatted the way a resume writes them. */
export const US_METRO_SUGGESTIONS: string[] = [
  "New York, NY",
  "Los Angeles, CA",
  "Chicago, IL",
  "Houston, TX",
  "Phoenix, AZ",
  "Philadelphia, PA",
  "San Antonio, TX",
  "San Diego, CA",
  "Dallas, TX",
  "San Jose, CA",
  "Austin, TX",
  "Jacksonville, FL",
  "Fort Worth, TX",
  "Columbus, OH",
  "Charlotte, NC",
  "San Francisco, CA",
  "Indianapolis, IN",
  "Seattle, WA",
  "Denver, CO",
  "Washington, DC",
  "Boston, MA",
  "Nashville, TN",
  "Oklahoma City, OK",
  "El Paso, TX",
  "Las Vegas, NV",
  "Portland, OR",
  "Detroit, MI",
  "Memphis, TN",
  "Louisville, KY",
  "Baltimore, MD",
  "Milwaukee, WI",
  "Albuquerque, NM",
  "Tucson, AZ",
  "Fresno, CA",
  "Sacramento, CA",
  "Mesa, AZ",
  "Atlanta, GA",
  "Kansas City, MO",
  "Colorado Springs, CO",
  "Raleigh, NC",
  "Omaha, NE",
  "Miami, FL",
  "Long Beach, CA",
  "Virginia Beach, VA",
  "Oakland, CA",
  "Minneapolis, MN",
  "Tulsa, OK",
  "Tampa, FL",
  "Arlington, TX",
  "New Orleans, LA",
];

/** Top 20 international destinations candidates realistically target. */
export const INTERNATIONAL_SUGGESTIONS: string[] = [
  "London, United Kingdom",
  "Toronto, Canada",
  "Vancouver, Canada",
  "Berlin, Germany",
  "Munich, Germany",
  "Paris, France",
  "Amsterdam, Netherlands",
  "Dublin, Ireland",
  "Singapore",
  "Sydney, Australia",
  "Melbourne, Australia",
  "Tokyo, Japan",
  "Bangalore, India",
  "Tel Aviv, Israel",
  "Zurich, Switzerland",
  "Stockholm, Sweden",
  "Hong Kong",
  "Barcelona, Spain",
  "Madrid, Spain",
  "Copenhagen, Denmark",
];

/**
 * The combined suggestion list the picker filters against. Remote first,
 * since it is the single most common answer, then US metros, then
 * international destinations.
 */
export const LOCATION_SUGGESTIONS: string[] = [
  REMOTE_SUGGESTION,
  ...US_METRO_SUGGESTIONS,
  ...INTERNATIONAL_SUGGESTIONS,
];
