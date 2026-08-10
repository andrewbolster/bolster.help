// Tools reachable through the public proxy.
//
// Explicit rather than derived from tools.json: a tool added upstream should
// stay unreachable until someone decides it is safe to expose anonymously.
//
// Deliberately absent:
//   bolster_get_precipitation — every call spends the Met Office API key quota
//   send_contact_message      — write side-effect, delivers mail to a real inbox
export const ALLOWED_TOOLS = new Set([
  "bolster_cinema_listings",
  "bolster_companies_house",
  "bolster_dva",
  "bolster_gender_pay_gap",
  "bolster_ni_elections",
  "bolster_ni_executive",
  "bolster_ni_house_prices",
  "bolster_nisra_ashe",
  "bolster_nisra_births",
  "bolster_nisra_cancer_waiting_times",
  "bolster_nisra_civil_partnerships",
  "bolster_nisra_composite_index",
  "bolster_nisra_construction_output",
  "bolster_nisra_deaths",
  "bolster_nisra_emergency_care",
  "bolster_nisra_feed",
  "bolster_nisra_index_of_production",
  "bolster_nisra_index_of_services",
  "bolster_nisra_labour_market",
  "bolster_nisra_marriages",
  "bolster_nisra_migration",
  "bolster_nisra_occupancy",
  "bolster_nisra_planning_statistics",
  "bolster_nisra_population",
  "bolster_nisra_population_projections",
  "bolster_nisra_registrar_general",
  "bolster_nisra_visitors",
  "bolster_nisra_wellbeing",
  "bolster_psni_rtc",
  "bolster_rss_nisra_statistics",
  "bolster_rss_read",
  "bolster_water_quality",
  "check_availability",
  "get_recent_blog_posts",
]);

export const ALLOWED_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
  "ping",
]);
