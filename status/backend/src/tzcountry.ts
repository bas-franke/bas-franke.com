/**
 * Browser time zone → ISO 3166-1 alpha-2 country, so the analytics can show countries without IP geolocation.
 * Covers every zone browsers report (current IANA names and the older aliases some browsers still use, such as
 * Asia/Calcutta next to Asia/Kolkata and Europe/Kiev next to Europe/Kyiv). Unknown zones (and UTC) map to 'ZZ'.
 * A time zone is a coarse hint: a few zones span several countries, and travellers keep their home zone.
 */

// Per region: "Zone CC Zone CC ...", the zone name without its region prefix.
const TABLE: Record<string, string> = {
  Africa: `Abidjan CI Accra GH Addis_Ababa ET Algiers DZ Asmara ER Asmera ER Bamako ML Bangui CF Banjul GM Bissau GW
    Blantyre MW Brazzaville CG Bujumbura BI Cairo EG Casablanca MA Ceuta ES Conakry GN Dakar SN Dar_es_Salaam TZ
    Djibouti DJ Douala CM El_Aaiun EH Freetown SL Gaborone BW Harare ZW Johannesburg ZA Juba SS Kampala UG Khartoum SD
    Kigali RW Kinshasa CD Lagos NG Libreville GA Lome TG Luanda AO Lubumbashi CD Lusaka ZM Malabo GQ Maputo MZ
    Maseru LS Mbabane SZ Mogadishu SO Monrovia LR Nairobi KE Ndjamena TD Niamey NE Nouakchott MR Ouagadougou BF
    Porto-Novo BJ Sao_Tome ST Timbuktu ML Tripoli LY Tunis TN Windhoek NA`,
  America: `Adak US Anchorage US Anguilla AI Antigua AG Araguaina BR Argentina/Buenos_Aires AR Argentina/Catamarca AR
    Argentina/ComodRivadavia AR Argentina/Cordoba AR Argentina/Jujuy AR Argentina/La_Rioja AR Argentina/Mendoza AR
    Argentina/Rio_Gallegos AR Argentina/Salta AR Argentina/San_Juan AR Argentina/San_Luis AR Argentina/Tucuman AR
    Argentina/Ushuaia AR Aruba AW Asuncion PY Atikokan CA Atka US Bahia BR Bahia_Banderas MX Barbados BB Belem BR
    Belize BZ Blanc-Sablon CA Boa_Vista BR Bogota CO Boise US Buenos_Aires AR Cambridge_Bay CA Campo_Grande BR
    Cancun MX Caracas VE Catamarca AR Cayenne GF Cayman KY Chicago US Chihuahua MX Ciudad_Juarez MX Coral_Harbour CA
    Cordoba AR Costa_Rica CR Coyhaique CL Creston CA Cuiaba BR Curacao CW Danmarkshavn GL Dawson CA Dawson_Creek CA
    Denver US Detroit US Dominica DM Edmonton CA Eirunepe BR El_Salvador SV Ensenada MX Fort_Nelson CA Fort_Wayne US
    Fortaleza BR Glace_Bay CA Godthab GL Goose_Bay CA Grand_Turk TC Grenada GD Guadeloupe GP Guatemala GT
    Guayaquil EC Guyana GY Halifax CA Havana CU Hermosillo MX Indiana/Indianapolis US Indiana/Knox US
    Indiana/Marengo US Indiana/Petersburg US Indiana/Tell_City US Indiana/Vevay US Indiana/Vincennes US
    Indiana/Winamac US Indianapolis US Inuvik CA Iqaluit CA Jamaica JM Jujuy AR Juneau US Kentucky/Louisville US
    Kentucky/Monticello US Knox_IN US Kralendijk BQ La_Paz BO Lima PE Los_Angeles US Louisville US Lower_Princes SX
    Maceio BR Managua NI Manaus BR Marigot MF Martinique MQ Matamoros MX Mazatlan MX Mendoza AR Menominee US Merida MX
    Metlakatla US Mexico_City MX Miquelon PM Moncton CA Monterrey MX Montevideo UY Montreal CA Montserrat MS Nassau BS
    New_York US Nipigon CA Nome US Noronha BR North_Dakota/Beulah US North_Dakota/Center US North_Dakota/New_Salem US
    Nuuk GL Ojinaga MX Panama PA Pangnirtung CA Paramaribo SR Phoenix US Port-au-Prince HT Port_of_Spain TT
    Porto_Acre BR Porto_Velho BR Puerto_Rico PR Punta_Arenas CL Rainy_River CA Rankin_Inlet CA Recife BR Regina CA
    Resolute CA Rio_Branco BR Rosario AR Santa_Isabel MX Santarem BR Santiago CL Santo_Domingo DO Sao_Paulo BR
    Scoresbysund GL Shiprock US Sitka US St_Barthelemy BL St_Johns CA St_Kitts KN St_Lucia LC St_Thomas VI
    St_Vincent VC Swift_Current CA Tegucigalpa HN Thule GL Thunder_Bay CA Tijuana MX Toronto CA Tortola VG
    Vancouver CA Virgin VI Whitehorse CA Winnipeg CA Yakutat US Yellowknife CA`,
  Antarctica: `Casey AQ Davis AQ DumontDUrville AQ Macquarie AU Mawson AQ McMurdo AQ Palmer AQ Rothera AQ South_Pole AQ
    Syowa AQ Troll AQ Vostok AQ`,
  Arctic: `Longyearbyen SJ`,
  Asia: `Aden YE Almaty KZ Amman JO Anadyr RU Aqtau KZ Aqtobe KZ Ashgabat TM Ashkhabad TM Atyrau KZ Baghdad IQ
    Bahrain BH Baku AZ Bangkok TH Barnaul RU Beirut LB Bishkek KG Brunei BN Calcutta IN Chita RU Choibalsan MN
    Chongqing CN Chungking CN Colombo LK Dacca BD Damascus SY Dhaka BD Dili TL Dubai AE Dushanbe TJ Famagusta CY
    Gaza PS Harbin CN Hebron PS Ho_Chi_Minh VN Hong_Kong HK Hovd MN Irkutsk RU Istanbul TR Jakarta ID Jayapura ID
    Jerusalem IL Kabul AF Kamchatka RU Karachi PK Kashgar CN Kathmandu NP Katmandu NP Khandyga RU Kolkata IN
    Krasnoyarsk RU Kuala_Lumpur MY Kuching MY Kuwait KW Macao MO Macau MO Magadan RU Makassar ID Manila PH Muscat OM
    Nicosia CY Novokuznetsk RU Novosibirsk RU Omsk RU Oral KZ Phnom_Penh KH Pontianak ID Pyongyang KP Qatar QA
    Qostanay KZ Qyzylorda KZ Rangoon MM Riyadh SA Saigon VN Sakhalin RU Samarkand UZ Seoul KR Shanghai CN
    Singapore SG Srednekolymsk RU Taipei TW Tashkent UZ Tbilisi GE Tehran IR Tel_Aviv IL Thimbu BT Thimphu BT
    Tokyo JP Tomsk RU Ujung_Pandang ID Ulaanbaatar MN Ulan_Bator MN Urumqi CN Ust-Nera RU Vientiane LA
    Vladivostok RU Yakutsk RU Yangon MM Yekaterinburg RU Yerevan AM`,
  Atlantic: `Azores PT Bermuda BM Canary ES Cape_Verde CV Faeroe FO Faroe FO Jan_Mayen SJ Madeira PT Reykjavik IS
    South_Georgia GS St_Helena SH Stanley FK`,
  Australia: `ACT AU Adelaide AU Brisbane AU Broken_Hill AU Canberra AU Currie AU Darwin AU Eucla AU Hobart AU LHI AU
    Lindeman AU Lord_Howe AU Melbourne AU NSW AU North AU Perth AU Queensland AU South AU Sydney AU Tasmania AU
    Victoria AU West AU Yancowinna AU`,
  Europe: `Amsterdam NL Andorra AD Astrakhan RU Athens GR Belfast GB Belgrade RS Berlin DE Bratislava SK Brussels BE
    Bucharest RO Budapest HU Busingen DE Chisinau MD Copenhagen DK Dublin IE Gibraltar GI Guernsey GG Helsinki FI
    Isle_of_Man IM Istanbul TR Jersey JE Kaliningrad RU Kiev UA Kirov RU Kyiv UA Lisbon PT Ljubljana SI London GB
    Luxembourg LU Madrid ES Malta MT Mariehamn AX Minsk BY Monaco MC Moscow RU Nicosia CY Oslo NO Paris FR
    Podgorica ME Prague CZ Riga LV Rome IT Samara RU San_Marino SM Sarajevo BA Saratov RU Simferopol UA Skopje MK
    Sofia BG Stockholm SE Tallinn EE Tirane AL Tiraspol MD Ulyanovsk RU Uzhgorod UA Vaduz LI Vatican VA Vienna AT
    Vilnius LT Volgograd RU Warsaw PL Zagreb HR Zaporozhye UA Zurich CH`,
  Indian: `Antananarivo MG Chagos IO Christmas CX Cocos CC Comoro KM Kerguelen TF Mahe SC Maldives MV Mauritius MU
    Mayotte YT Reunion RE`,
  Pacific: `Apia WS Auckland NZ Bougainville PG Chatham NZ Chuuk FM Easter CL Efate VU Enderbury KI Fakaofo TK Fiji FJ
    Funafuti TV Galapagos EC Gambier PF Guadalcanal SB Guam GU Honolulu US Johnston UM Kanton KI Kiritimati KI
    Kosrae FM Kwajalein MH Majuro MH Marquesas PF Midway UM Nauru NR Niue NU Norfolk NF Noumea NC Pago_Pago AS
    Palau PW Pitcairn PN Pohnpei FM Ponape FM Port_Moresby PG Rarotonga CK Saipan MP Samoa AS Tahiti PF Tarawa KI
    Tongatapu TO Truk FM Wake UM Wallis WF Yap FM`,
  US: `Alaska US Aleutian US Arizona US Central US East-Indiana US Eastern US Hawaii US Indiana-Starke US Michigan US
    Mountain US Pacific US Samoa AS`,
  Canada: `Atlantic CA Central CA Eastern CA Mountain CA Newfoundland CA Pacific CA Saskatchewan CA Yukon CA`,
  Brazil: `Acre BR DeNoronha BR East BR West BR`,
  Chile: `Continental CL EasterIsland CL`,
  Mexico: `BajaNorte MX BajaSur MX General MX`,
  // Legacy zone names without a region.
  '': `Cuba CU Egypt EG Eire IE GB GB GB-Eire GB Hongkong HK Iceland IS Iran IR Israel IL Jamaica JM Japan JP
    Kwajalein MH Libya LY NZ NZ NZ-CHAT NZ Navajo US PRC CN Poland PL Portugal PT ROC TW ROK KR Singapore SG
    Turkey TR W-SU RU`,
};

const COUNTRY = new Map<string, string>();
for (const [region, list] of Object.entries(TABLE)) {
  const tokens = list.trim().split(/\s+/);
  for (let i = 0; i + 1 < tokens.length; i += 2) COUNTRY.set(region ? `${region}/${tokens[i]}` : tokens[i], tokens[i + 1]);
}

/** 'Europe/Amsterdam' → 'NL'; anything unknown → 'ZZ'. */
export const countryForTimeZone = (tz: string | undefined) => (tz && COUNTRY.get(tz)) || 'ZZ';

/** Number of zones in the table (for tests). */
export const knownTimeZones = () => [...COUNTRY.keys()];
