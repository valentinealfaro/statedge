// 30 NBA teams. team_id matches stats.nba.com.
export type NbaTeam = {
  id: number;
  abbreviation: string;
  city: string;
  name: string;
  fullName: string;
  conference: 'East' | 'West';
};

export const NBA_TEAMS: NbaTeam[] = [
  { id: 1610612737, abbreviation: 'ATL', city: 'Atlanta',       name: 'Hawks',          fullName: 'Atlanta Hawks',          conference: 'East' },
  { id: 1610612738, abbreviation: 'BOS', city: 'Boston',        name: 'Celtics',        fullName: 'Boston Celtics',         conference: 'East' },
  { id: 1610612751, abbreviation: 'BKN', city: 'Brooklyn',      name: 'Nets',           fullName: 'Brooklyn Nets',          conference: 'East' },
  { id: 1610612766, abbreviation: 'CHA', city: 'Charlotte',     name: 'Hornets',        fullName: 'Charlotte Hornets',      conference: 'East' },
  { id: 1610612741, abbreviation: 'CHI', city: 'Chicago',       name: 'Bulls',          fullName: 'Chicago Bulls',          conference: 'East' },
  { id: 1610612739, abbreviation: 'CLE', city: 'Cleveland',     name: 'Cavaliers',      fullName: 'Cleveland Cavaliers',    conference: 'East' },
  { id: 1610612742, abbreviation: 'DAL', city: 'Dallas',        name: 'Mavericks',      fullName: 'Dallas Mavericks',       conference: 'West' },
  { id: 1610612743, abbreviation: 'DEN', city: 'Denver',        name: 'Nuggets',        fullName: 'Denver Nuggets',         conference: 'West' },
  { id: 1610612765, abbreviation: 'DET', city: 'Detroit',       name: 'Pistons',        fullName: 'Detroit Pistons',        conference: 'East' },
  { id: 1610612744, abbreviation: 'GSW', city: 'Golden State',  name: 'Warriors',       fullName: 'Golden State Warriors',  conference: 'West' },
  { id: 1610612745, abbreviation: 'HOU', city: 'Houston',       name: 'Rockets',        fullName: 'Houston Rockets',        conference: 'West' },
  { id: 1610612754, abbreviation: 'IND', city: 'Indiana',       name: 'Pacers',         fullName: 'Indiana Pacers',         conference: 'East' },
  { id: 1610612746, abbreviation: 'LAC', city: 'Los Angeles',   name: 'Clippers',       fullName: 'LA Clippers',            conference: 'West' },
  { id: 1610612747, abbreviation: 'LAL', city: 'Los Angeles',   name: 'Lakers',         fullName: 'Los Angeles Lakers',     conference: 'West' },
  { id: 1610612763, abbreviation: 'MEM', city: 'Memphis',       name: 'Grizzlies',      fullName: 'Memphis Grizzlies',      conference: 'West' },
  { id: 1610612748, abbreviation: 'MIA', city: 'Miami',         name: 'Heat',           fullName: 'Miami Heat',             conference: 'East' },
  { id: 1610612749, abbreviation: 'MIL', city: 'Milwaukee',     name: 'Bucks',          fullName: 'Milwaukee Bucks',        conference: 'East' },
  { id: 1610612750, abbreviation: 'MIN', city: 'Minnesota',     name: 'Timberwolves',   fullName: 'Minnesota Timberwolves', conference: 'West' },
  { id: 1610612740, abbreviation: 'NOP', city: 'New Orleans',   name: 'Pelicans',       fullName: 'New Orleans Pelicans',   conference: 'West' },
  { id: 1610612752, abbreviation: 'NYK', city: 'New York',      name: 'Knicks',         fullName: 'New York Knicks',        conference: 'East' },
  { id: 1610612760, abbreviation: 'OKC', city: 'Oklahoma City', name: 'Thunder',        fullName: 'Oklahoma City Thunder',  conference: 'West' },
  { id: 1610612753, abbreviation: 'ORL', city: 'Orlando',       name: 'Magic',          fullName: 'Orlando Magic',          conference: 'East' },
  { id: 1610612755, abbreviation: 'PHI', city: 'Philadelphia',  name: '76ers',          fullName: 'Philadelphia 76ers',     conference: 'East' },
  { id: 1610612756, abbreviation: 'PHX', city: 'Phoenix',       name: 'Suns',           fullName: 'Phoenix Suns',           conference: 'West' },
  { id: 1610612757, abbreviation: 'POR', city: 'Portland',      name: 'Trail Blazers',  fullName: 'Portland Trail Blazers', conference: 'West' },
  { id: 1610612758, abbreviation: 'SAC', city: 'Sacramento',    name: 'Kings',          fullName: 'Sacramento Kings',       conference: 'West' },
  { id: 1610612759, abbreviation: 'SAS', city: 'San Antonio',   name: 'Spurs',          fullName: 'San Antonio Spurs',      conference: 'West' },
  { id: 1610612761, abbreviation: 'TOR', city: 'Toronto',       name: 'Raptors',        fullName: 'Toronto Raptors',        conference: 'East' },
  { id: 1610612762, abbreviation: 'UTA', city: 'Utah',          name: 'Jazz',           fullName: 'Utah Jazz',              conference: 'West' },
  { id: 1610612764, abbreviation: 'WAS', city: 'Washington',    name: 'Wizards',        fullName: 'Washington Wizards',     conference: 'East' },
];

export function teamById(id: number): NbaTeam | undefined {
  return NBA_TEAMS.find((t) => t.id === id);
}

export function teamByAbbr(abbr: string): NbaTeam | undefined {
  const a = abbr.toUpperCase();
  return NBA_TEAMS.find((t) => t.abbreviation === a);
}
