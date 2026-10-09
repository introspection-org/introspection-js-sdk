/**
 * Flight Sector's world for the demo: two customer companies with their own
 * travel policy, their employees, and the inventory the booking provider sells.
 * Slack ids match the platform's local Slack emulator seed; on a real
 * workspace, set ACME_WORKSPACE_ID and ACME_SAM_USER_ID to the presenter's, and
 * ACME_DANA_EMAIL to the inbox Dana's approvals should reach.
 */

const ACME = process.env.ACME_WORKSPACE_ID || "T0ACME";
const SAM = `slack:${ACME}/${process.env.ACME_SAM_USER_ID || "U0SAM"}`;
const DANA = `slack:${ACME}/${process.env.ACME_DANA_USER_ID || "U0DANA"}`;

export interface Zone {
  hotel_nightly_cap_cents: number;
  flight_cap_cents: number;
}

export interface Company {
  name: string;
  workspace_id: string;
  cabin_business_min_level: number;
  cabin_business_min_minutes: number;
  zones: Record<string, Zone>;
}

export interface Person {
  external_user_id: string;
  company: string;
  name: string;
  email: string;
  seniority_level: number;
  manager?: string;
}

export interface Flight {
  id: string;
  carrier: string;
  flight: string;
  from: string;
  to: string;
  depart_time: string;
  block_minutes: number;
  stops: number;
  fares_cents: Record<string, number>;
}

export interface Hotel {
  id: string;
  name: string;
  city: string;
  nightly_cents: number;
}

export const companies: Record<string, Company> = {
  acme: {
    name: "Acme",
    workspace_id: ACME,
    cabin_business_min_level: 5,
    cabin_business_min_minutes: 360,
    zones: {
      SYD: { hotel_nightly_cap_cents: 30000, flight_cap_cents: 900000 },
      MEL: { hotel_nightly_cap_cents: 27500, flight_cap_cents: 900000 },
      SFO: { hotel_nightly_cap_cents: 35000, flight_cap_cents: 900000 },
    },
  },
  globex: {
    name: "Globex",
    workspace_id: "T0GLOBEX",
    cabin_business_min_level: 7,
    cabin_business_min_minutes: 360,
    zones: {
      SYD: { hotel_nightly_cap_cents: 25000, flight_cap_cents: 400000 },
      MEL: { hotel_nightly_cap_cents: 25000, flight_cap_cents: 400000 },
      SFO: { hotel_nightly_cap_cents: 30000, flight_cap_cents: 400000 },
    },
  },
};

export const people: Person[] = [
  {
    external_user_id: SAM,
    company: "acme",
    name: "Sam Rivera",
    email: "sam@acme.example",
    seniority_level: 5,
    manager: DANA,
  },
  {
    external_user_id: DANA,
    company: "acme",
    name: "Dana Park",
    email: process.env.ACME_DANA_EMAIL || "dana@acme.example",
    seniority_level: 7,
  },
  {
    external_user_id: "slack:T0GLOBEX/U0LEE",
    company: "globex",
    name: "Lee Chen",
    email: "lee@globex.example",
    seniority_level: 5,
    manager: "slack:T0GLOBEX/U0AVA",
  },
  {
    external_user_id: "slack:T0GLOBEX/U0AVA",
    company: "globex",
    name: "Ava Moss",
    email: "ava@globex.example",
    seniority_level: 8,
  },
];

export const flights: Flight[] = [
  {
    id: "qf74",
    carrier: "QF",
    flight: "QF74",
    from: "SFO",
    to: "SYD",
    depart_time: "22:40",
    block_minutes: 875,
    stops: 0,
    fares_cents: {
      economy: 165000,
      premium_economy: 340000,
      business: 780000,
      first: 1500000,
    },
  },
  {
    id: "ua863",
    carrier: "UA",
    flight: "UA863",
    from: "SFO",
    to: "SYD",
    depart_time: "23:15",
    block_minutes: 885,
    stops: 0,
    fares_cents: { economy: 158000, premium_economy: 320000, business: 745000 },
  },
  {
    id: "qf429",
    carrier: "QF",
    flight: "QF429",
    from: "SYD",
    to: "MEL",
    depart_time: "17:30",
    block_minutes: 95,
    stops: 0,
    fares_cents: { economy: 21000, business: 64000 },
  },
  {
    id: "qf93",
    carrier: "QF",
    flight: "QF93",
    from: "MEL",
    to: "SFO",
    depart_time: "12:05",
    block_minutes: 860,
    stops: 0,
    fares_cents: { economy: 172000, premium_economy: 350000, business: 790000 },
  },
  {
    id: "qf73",
    carrier: "QF",
    flight: "QF73",
    from: "SYD",
    to: "SFO",
    depart_time: "21:20",
    block_minutes: 830,
    stops: 0,
    fares_cents: { economy: 160000, premium_economy: 335000, business: 770000 },
  },
];

export const hotels: Hotel[] = [
  { id: "qt-sydney", name: "QT Sydney", city: "SYD", nightly_cents: 42000 },
  {
    id: "harbour-rocks",
    name: "Harbour Rocks Hotel",
    city: "SYD",
    nightly_cents: 28000,
  },
  {
    id: "qt-melbourne",
    name: "QT Melbourne",
    city: "MEL",
    nightly_cents: 39000,
  },
];
