// Every data source carries its own compliance record. Collection is refused unless
// the owner has recorded authorization for commercial reuse + redistribution.

export const REQUIRED_SOURCE_FIELDS = ['name', 'agency', 'url', 'method', 'termsUrl'];

export function sourceComplianceIssues(s) {
  const issues = [];
  for (const f of REQUIRED_SOURCE_FIELDS) if (!s[f]) issues.push(`missing ${f}`);
  const a = s.authorization || {};
  if (!a.commercialReuse) issues.push('commercial reuse not confirmed');
  if (!a.redistribution) issues.push('redistribution to subscribers not confirmed');
  if (!a.reviewedBy || !a.reviewedAt) issues.push('no named reviewer/date for terms review');
  if (!a.evidence) issues.push('no evidence reference (license, terms snapshot, or written permission)');
  if (['socrata', 'arcgis'].includes(s.adapter) && (!s.adapterConfig?.fields?.permitId || !s.adapterConfig?.dateField)) issues.push('field map not set (run the probe)');
  if (s.method === 'scrape') issues.push('scraping is disabled platform-wide; use an API, bulk file, or licensed feed');
  if (s.requiresAuth && !s.credentialEnv) issues.push('source requires credentials but none configured');
  return issues;
}

export function canCollect(s) {
  return s.enabled === true && sourceComplianceIssues(s).length === 0;
}

// Starting catalog. Authorization fields are intentionally EMPTY: the owner must review
// each source's terms and record the decision. Nothing here is pre-approved.
export const STARTER_SOURCES = [
  {
    key: 'dallas-socrata',
    name: 'City of Dallas Building Permits (Open Data)',
    agency: 'City of Dallas',
    jurisdiction: 'dallas-tx', city: 'Dallas', state: 'TX',
    url: 'https://www.dallasopendata.com/d/e7gq-4sah',
    termsUrl: 'https://www.dallasopendata.com/stories/s/Terms-of-Use',
    method: 'api', adapter: 'socrata',
    adapterConfig: {
      domain: 'www.dallasopendata.com', dataset: 'e7gq-4sah',
      // field map: BUILDINTEL field -> source column. Verify against the live schema before enabling.
      fields: { permitId: 'permit_number', permitType: 'permit_type', issuedDate: 'issued_date',
        address: 'street_address', zip: 'zip_code', contractor: 'contractor', valuation: 'value',
        squareFeet: 'area', description: 'work_description', landUse: 'land_use' },
      dateField: 'issued_date',
    },
    rateLimitPerMin: 30,
    notes: 'Dallas moved permitting to DallasNow (Accela) in May 2025. Freshness gate will flag this dataset if it has stopped updating; if so, request a DallasNow export or data agreement.',
  },
  {
    key: 'sam-gov',
    name: 'SAM.gov Contract Opportunities',
    agency: 'U.S. General Services Administration',
    jurisdiction: 'federal', city: null, state: null,
    url: 'https://sam.gov/search/?index=opp',
    termsUrl: 'https://open.gsa.gov/api/get-opportunities-public-api/',
    method: 'api', adapter: 'samgov', requiresAuth: true, credentialEnv: 'SAM_API_KEY',
    adapterConfig: { naics: ['561720', '561790', '238990'], states: ['IA', 'TX'] },
    rateLimitPerMin: 5,
    notes: 'New non-federal keys have a small daily quota; the adapter makes one call per cycle per state.',
  },
  {
    key: 'wdm-reports',
    name: 'West Des Moines Monthly Building Permit Reports',
    agency: 'City of West Des Moines',
    jurisdiction: 'west-des-moines-ia', city: 'West Des Moines', state: 'IA',
    url: 'https://www.wdm.iowa.gov',
    termsUrl: 'https://www.wdm.iowa.gov',
    method: 'file_import', adapter: 'csv',
    adapterConfig: {},
    notes: 'Published as monthly PDF reports. Convert to CSV and import via /api/admin/sources/:id/import, or request a direct export from the city.',
  },
  {
    key: 'des-moines-records',
    name: 'City of Des Moines Permit Records',
    agency: 'City of Des Moines',
    jurisdiction: 'des-moines-ia', city: 'Des Moines', state: 'IA',
    url: 'https://www.dsm.city', termsUrl: 'https://www.dsm.city',
    method: 'file_import', adapter: 'csv', adapterConfig: {},
    notes: 'Request a recurring commercial permit export (public records request) and import the file.',
  },
  {
    key: 'ankeny-records',
    name: 'City of Ankeny Permit Records',
    agency: 'City of Ankeny',
    jurisdiction: 'ankeny-ia', city: 'Ankeny', state: 'IA',
    url: 'https://www.ankenyiowa.gov', termsUrl: 'https://www.ankenyiowa.gov',
    method: 'file_import', adapter: 'csv', adapterConfig: {},
    notes: 'Request a recurring commercial permit export and import the file.',
  },
];

// Open-data metros. Field maps are best-known column names; run POST /api/sources/:id/probe
// before enabling — it lists the live columns and flags any mapping that doesn't exist.
const socrataMetro = (key, name, agency, city, state, domain, dataset, fields, dateField, extra = {}) => ({
  key, name, agency, jurisdiction: key, city, state,
  url: `https://${domain}/d/${dataset}`, termsUrl: `https://${domain}`, method: 'api', adapter: 'socrata',
  adapterConfig: { domain, dataset, fields, dateField, ...extra }, rateLimitPerMin: 30,
  notes: 'Run the probe and confirm the field map before enabling. Record the portal terms review.',
});

export const CHICAGO_DISCLAIMER = 'This site provides applications using data that has been modified for use from its original source, www.cityofchicago.org, the official website of the City of Chicago. The City of Chicago makes no claims as to the content, accuracy, timeliness, or completeness of any of the data provided at this site. The data provided at this site is subject to change at any time. It is understood that the data provided at this site is being used at one\'s own risk.';

STARTER_SOURCES.push(
  socrataMetro('austin-tx', 'City of Austin Issued Construction Permits', 'City of Austin', 'Austin', 'TX', 'data.austintexas.gov', '3syk-w9eu',
    { permitId: 'permit_number', permitType: 'permit_type_desc', workClass: 'work_class', issuedDate: 'issue_date', appliedDate: 'applieddate',
      address: 'original_address1', zip: 'original_zip', contractor: 'contractor_company_name',
      valuation: { any: ['total_job_valuation', 'building_valuation', 'building_valuation_remodel', 'total_valuation_remodel'] },
      squareFeet: { any: ['total_new_add_sqft', 'remodel_repair_sqft'] }, description: 'description', status: 'status_current', occupancy: 'permit_class' },
    'issue_date', { sourceUrlField: 'link',
      // Building permits only (trade sub-permits duplicate the same project); commercial class; no sign permits.
      where: "permit_type_desc = 'Building Permit' AND permit_class_mapped = 'Commercial' AND permit_class != 'Sign Permit'" }),
  socrataMetro('chicago-il', 'City of Chicago Building Permits', 'City of Chicago', 'Chicago', 'IL', 'data.cityofchicago.org', 'ydr8-5enu',
    { permitId: 'permit_', permitType: 'permit_type', issuedDate: 'issue_date', appliedDate: 'application_start_date',
      address: ['street_number', 'street_direction', 'street_name'], valuation: 'reported_cost', description: 'work_description', status: 'permit_status' }, 'issue_date',
    { contactSlots: { prefix: 'contact_', count: 15, typeSuffix: '_type', nameSuffix: '_name',
      roles: { contractor: 'GENERAL CONTRACTOR', owner: 'OWNER', architect: 'ARCHITECT' } } }),
  socrataMetro('seattle-wa', 'City of Seattle Building Permits', 'City of Seattle', 'Seattle', 'WA', 'data.seattle.gov', '76t5-zqzr',
    { permitId: 'permitnum', permitType: 'permittypedesc', workClass: 'permitclass', issuedDate: 'issueddate', appliedDate: 'applieddate',
      address: 'originaladdress1', zip: 'originalzip', contractor: 'contractorcompanyname', valuation: 'estprojectcost', description: 'description',
      status: 'statuscurrent', occupancy: 'permitclass' }, 'issueddate'),
);

for (const src of STARTER_SOURCES) {
  if (src.key === 'chicago-il') {
    src.attribution = CHICAGO_DISCLAIMER;
    src.termsUrl = 'https://www.chicago.gov/city/en/narr/foia/data_disclaimer.html';
    src.notes = 'Terms allow use in apps if this disclaimer is shown (built in). Terms also include an indemnity of the City and let it demand that use stop. Owner must accept those before switching on.';
  }
}

// ArcGIS metros (Minnesota). Probe first: it reads the live layer schema and edit date.
const arcgisMetro = (key, name, agency, city, state, cfg, notes) => ({
  key, name, agency, jurisdiction: key, city, state, url: cfg.serviceUrl || `https://hub.arcgis.com/datasets/${cfg.itemId}`,
  termsUrl: cfg.termsUrl, method: 'api', adapter: 'arcgis', adapterConfig: cfg, rateLimitPerMin: 20,
  notes: notes || 'Run the probe and confirm the field map before enabling. Record the portal terms review.',
});
STARTER_SOURCES.push(
  arcgisMetro('minneapolis-mn', 'City of Minneapolis CCS Permits (commercial)', 'City of Minneapolis', 'Minneapolis', 'MN', {
    serviceUrl: 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer', layer: 0,
    termsUrl: 'https://opendata.minneapolismn.gov', where: "PermitType = 'Commercial'", dateField: 'IssueDate',
    fields: { permitId: 'PermitNumber', permitType: 'PermitType', workClass: 'WorkType', status: 'Status', valuation: 'Value',
      issuedDate: 'IssueDate', address: 'Display', contractor: 'ApplicantName', owner: 'FullName', description: 'WorkType' } },
    'ApplicantName is whoever pulled the permit (contractor or owner). Server-side filter keeps commercial permits only.'),
  arcgisMetro('saint-paul-mn', 'City of Saint Paul Approved Building Permits', 'City of Saint Paul', 'Saint Paul', 'MN', {
    itemId: '85d285812604427c9270ea44842081d0', layer: 0, termsUrl: 'https://information.stpaul.gov', dateField: '', fields: {} },
    'Field map not set yet: run the probe, then set fields + dateField from the real columns before enabling.'),
);

// Enrichment + early-signal sources.
STARTER_SOURCES.push(
  { key: 'wa-lni-licenses', name: 'Washington L&I Contractor License Register', agency: 'WA Department of Labor & Industries',
    jurisdiction: 'wa-state', city: null, state: 'WA', url: 'https://data.wa.gov/d/m8qx-ubtq', termsUrl: 'http://opendatacommons.org/licenses/pddl/1.0/',
    method: 'api', adapter: 'license-socrata', rateLimitPerMin: 30,
    adapterConfig: { domain: 'data.wa.gov', dataset: 'm8qx-ubtq', nameField: 'businessname',
      // businessname / contractorlicensenumber / contractorlicensestatus / contractorlicensetypecodedesc confirmed from published records;
      // the rest are expected names: confirm with the probe before enabling (missing columns simply come back empty).
      fields: { licenseNumber: 'contractorlicensenumber', businessName: 'businessname', status: 'contractorlicensestatus', type: 'contractorlicensetypecodedesc',
        phone: 'phonenumber', address: 'address1', city: 'city', zip: 'zip', expiresAt: 'licenseexpirationdate', principal: 'primaryprincipalname',
        specialties: ['specialtycode1desc', 'specialtycode2desc'] } },
    notes: 'Public domain (PDDL). Owner approved 2026-11-02. Looks up only contractors named on WA permits. Confirm the field map with the probe before enabling.' },
  { key: 'seattle-legistar', name: 'Seattle City Council Land-Use Legislation (Legistar)', agency: 'Seattle City Council',
    jurisdiction: 'seattle-wa', city: 'Seattle', state: 'WA', url: 'https://seattle.legistar.com', termsUrl: 'https://seattle.legistar.com',
    method: 'api', adapter: 'legistar', rateLimitPerMin: 20, adapterConfig: { client: 'seattle', daysBack: 180 },
    notes: 'Public legislative records. Keeps only site-specific land-use items (rezones of a property, plats, street vacations). Seattle decides most projects administratively, so expect few.' },
  { key: 'seattle-land-use', name: 'Seattle Land Use Permits (SDCI master use permits, design review)', agency: 'Seattle Dept. of Construction & Inspections',
    jurisdiction: 'seattle-wa', city: 'Seattle', state: 'WA', url: 'https://data.seattle.gov/d/ht3q-kdvx', termsUrl: 'https://data.seattle.gov',
    method: 'api', adapter: 'signals-socrata', rateLimitPerMin: 30,
    adapterConfig: { domain: 'data.seattle.gov', dataset: 'ht3q-kdvx', windowDays: 180, windowFields: [], fields: {} },
    notes: 'Site-specific land-use applications that precede building permits. Set fields + windowFields from the probe before enabling.' },
);

export function seedSources(store) {
  const byKey = new Map(store.list('sources').map(s => [s.key, s]));
  for (const s of STARTER_SOURCES) {
    const cur = byKey.get(s.key);
    if (cur && (cur.attribution || null) !== (s.attribution || null)) { cur.attribution = s.attribution || null; if (!cur.enabled) { cur.termsUrl = s.termsUrl; cur.notes = s.notes; } store.put('sources', cur); }
    if (cur) {
      // Catalog corrections reach sources that aren't live yet. Live (enabled) sources are never changed underneath the owner.
      if (!cur.enabled && JSON.stringify(cur.adapterConfig) !== JSON.stringify(s.adapterConfig)) {
        Object.assign(cur, { adapterConfig: structuredClone(s.adapterConfig), url: s.url, termsUrl: s.termsUrl, notes: s.notes });
        store.put('sources', cur);
      }
      continue;
    }
    store.put('sources', { ...structuredClone(s), enabled: false, authorization: {},
      lastSuccessAt: null, lastFailureAt: null, lastError: null, lastRecordDate: null });
  }
}
