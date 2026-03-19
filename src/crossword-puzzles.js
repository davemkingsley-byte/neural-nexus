// Crossword puzzle data - mirrored from public/crossword.html
// Used server-side to determine which puzzle ran on a given date

const PUZZLES = [
  { grid:[["H","E","A","R","T"],["E","M","B","E","R"],["A","B","U","S","E"],["R","E","S","I","N"],["T","R","E","N","D"]], clues:{across:{"1":"Vital organ","6":"Glowing coal","7":"Misuse","8":"Sticky tree sap","9":"Fashion direction"},down:{"1":"Courage or core","2":"Group member","3":"Mistreat","4":"Coating material","5":"Popular craze"}} },
  { grid:[["O","N","S","E","T"],["N","I","C","E","R"],["S","C","O","R","E"],["E","E","R","I","E"],["T","R","E","E","S"]], clues:{across:{"1":"Beginning","6":"More pleasant","7":"Game points","8":"Creepy","9":"Forest plants"},down:{"1":"Start of something","2":"Kinder","3":"Tally","4":"Spooky feeling","5":"Oaks and pines"}} },
  { grid:[["A","B","O","V","E"],["B","A","R","O","N"],["O","R","B","I","T"],["V","O","I","C","E"],["E","N","T","E","R"]], clues:{across:{"1":"Higher than","6":"Nobleman","7":"Path around a planet","8":"Speaking sound","9":"Come in"},down:{"1":"Overhead","2":"Medieval lord","3":"Satellite path","4":"Vocal expression","5":"Walk through a door"}} },
  { grid:[["B","E","A","S","T"],["E","A","R","T","H"],["A","R","M","O","R"],["S","T","O","N","E"],["T","H","R","E","E"]], clues:{across:{"1":"Wild animal","6":"Our planet","7":"Knight's protection","8":"Rock","9":"Number after two"},down:{"1":"Fierce creature","2":"Soil","3":"Protective covering","4":"Pebble material","5":"A small crowd"}} },
  { grid:[["A","P","A","R","T"],["P","O","L","A","R"],["A","L","I","V","E"],["R","A","V","E","N"],["T","R","E","N","D"]], clues:{across:{"1":"Separated","6":"Arctic or Antarctic","7":"Living","8":"Black bird","9":"Popular direction"},down:{"1":"In pieces","2":"Opposite ends","3":"Not dead","4":"Edgar Allan Poe bird","5":"What's hot right now"}} },
  { grid:[["C","R","A","N","E"],["R","I","V","A","L"],["A","V","O","I","D"],["N","A","I","V","E"],["E","L","D","E","R"]], clues:{across:{"1":"Construction machine","6":"Competitor","7":"Stay away from","8":"Innocent","9":"Older person"},down:{"1":"Tall bird","2":"Opponent","3":"Dodge","4":"Gullible","5":"Senior"}} },
  { grid:[["C","L","O","S","E"],["L","I","V","E","N"],["O","V","E","R","T"],["S","E","R","V","E"],["E","N","T","E","R"]], clues:{across:{"1":"Shut","6":"Energize","7":"Open and obvious","8":"Dish up food","9":"Come inside"},down:{"1":"Nearby","2":"Perk up","3":"Not hidden","4":"Wait on","5":"Type in a password"}} },
  { grid:[["A","L","I","V","E"],["L","I","N","E","N"],["I","N","E","R","T"],["V","E","R","S","E"],["E","N","T","E","R"]], clues:{across:{"1":"Living","6":"Bed sheet fabric","7":"Not reactive","8":"Poem section","9":"Go in"},down:{"1":"Breathing","2":"Table cloth material","3":"Motionless","4":"Line of poetry","5":"Key on a keyboard"}} },
  { grid:[["A","R","O","S","E"],["R","A","V","E","N"],["O","V","E","R","T"],["S","E","R","V","E"],["E","N","T","E","R"]], clues:{across:{"1":"Got up","6":"Black bird","7":"Obvious","8":"Dish up","9":"Walk in"},down:{"1":"Woke","2":"Poe's bird","3":"Unconcealed","4":"Help customers","5":"Type in"}} },
  { grid:[["C","H","E","A","T"],["H","O","R","S","E"],["E","R","A","S","E"],["A","S","S","E","T"],["T","E","E","T","H"]], clues:{across:{"1":"Break the rules","6":"Galloping animal","7":"Wipe clean","8":"Valuable resource","9":"What you brush"},down:{"1":"Copy answers","2":"Stallion or mare","3":"Delete","4":"Advantage","5":"Bite with these"}} },
  { grid:[["B","E","A","S","T"],["E","M","B","E","R"],["A","B","O","V","E"],["S","E","V","E","N"],["T","R","E","N","D"]], clues:{across:{"1":"Monster","6":"Hot coal","7":"Up higher","8":"Lucky number","9":"Direction things are going"},down:{"1":"Wild creature","2":"Dying fire remnant","3":"Overhead","4":"Days in a week","5":"Viral movement"}} },
  { grid:[["B","L","A","S","T"],["L","U","N","A","R"],["A","N","G","L","E"],["S","A","L","O","N"],["T","R","E","N","D"]], clues:{across:{"1":"Explosion","6":"Moon-related","7":"Corner measure","8":"Hair styling place","9":"Fashion movement"},down:{"1":"Have a ___!","2":"Eclipse type","3":"Geometry shape","4":"Beauty shop","5":"What's trending"}} },
  { grid:[["A","P","P","L","E"],["P","L","A","I","N"],["P","A","I","N","T"],["L","I","N","E","R"],["E","N","T","R","Y"]], clues:{across:{"1":"iPhone maker's fruit","6":"Simple","7":"Wall coating","8":"Cruise ship","9":"Way in"},down:{"1":"Pie filling fruit","2":"Not fancy","3":"Artist's medium","4":"Eye cosmetic","5":"Journal record"}} },
  { grid:[["A","S","S","E","T"],["S","O","L","A","R"],["S","L","A","T","E"],["E","A","T","E","N"],["T","R","E","N","D"]], clues:{across:{"1":"Something valuable","6":"Sun-powered","7":"Writing tablet","8":"Consumed","9":"Popular direction"},down:{"1":"Resource","2":"Panel on a roof","3":"Clean ___","4":"Had a meal","5":"Going viral"}} },
  { grid:[["C","O","M","E","T"],["O","P","E","R","A"],["M","E","T","A","L"],["E","R","A","S","E"],["T","A","L","E","S"]], clues:{across:{"1":"Icy space traveler","6":"Singing drama","7":"Iron or steel","8":"Delete","9":"Stories"},down:{"1":"Halley's ___","2":"La Scala show","3":"Rock music genre","4":"Rub out","5":"Fairy ___"}} },
  { grid:[["C","H","O","S","E"],["H","A","V","E","N"],["O","V","E","R","T"],["S","E","R","V","E"],["E","N","T","E","R"]], clues:{across:{"1":"Picked","6":"Safe place","7":"Obvious","8":"Pour drinks","9":"Go through a door"},down:{"1":"Selected","2":"Shelter","3":"Not secret","4":"Ace in tennis","5":"Join a contest"}} },
  { grid:[["C","R","E","S","T"],["R","A","N","C","H"],["E","N","T","E","R"],["S","C","E","N","E"],["T","H","R","E","E"]], clues:{across:{"1":"Wave top","6":"Cattle farm","7":"Come in","8":"Movie location","9":"Trio number"},down:{"1":"Toothpaste brand","2":"Cowboy's home","3":"Join","4":"Act of a play","5":"Little number"}} },
  { grid:[["B","R","A","S","S"],["R","I","G","H","T"],["A","G","R","E","E"],["S","H","E","E","R"],["S","T","E","R","N"]], clues:{across:{"1":"Trumpet material","6":"Correct","7":"See eye to eye","8":"Very thin fabric","9":"Ship's back end"},down:{"1":"Bold nerve","2":"Not left","3":"Nod along","4":"Pure or total","5":"Serious expression"}} },
  { grid:[["A","M","B","L","E"],["M","O","R","A","L"],["B","R","A","N","D"],["L","A","N","C","E"],["E","L","D","E","R"]], clues:{across:{"1":"Leisurely walk","6":"Story's lesson","7":"Company name","8":"Knight's weapon","9":"Senior person"},down:{"1":"Stroll","2":"Ethical","3":"Logo","4":"Pointed spear","5":"Older sibling"}} },
  { grid:[["C","A","R","G","O"],["A","B","O","R","T"],["R","O","B","O","T"],["G","R","O","V","E"],["O","T","T","E","R"]], clues:{across:{"1":"Ship's freight","6":"Cancel mission","7":"Mechanical worker","8":"Small forest","9":"Playful swimmer"},down:{"1":"Shipping load","2":"Call off","3":"AI body","4":"Orange juice brand","5":"River mammal"}} },
  { grid:[["B","L","A","S","T"],["L","U","N","C","H"],["A","N","G","E","R"],["S","C","E","N","E"],["T","H","R","E","W"]], clues:{across:{"1":"Explosion","6":"Midday meal","7":"Strong fury","8":"Movie setting","9":"Tossed"},down:{"1":"Sudden gust","2":"Noon break","3":"Rage","4":"Location","5":"Hurled"}} },
  { grid:[["B","U","R","S","T"],["U","N","I","T","E"],["R","I","D","E","R"],["S","T","E","A","M"],["T","E","R","M","S"]], clues:{across:{"1":"Pop suddenly","6":"Join together","7":"Horseback person","8":"Hot vapor","9":"Conditions"},down:{"1":"Sudden break","2":"Come as one","3":"Motorcycle user","4":"Boiling water output","5":"Agreement words"}} },
  { grid:[["C","L","A","S","S"],["L","I","G","H","T"],["A","G","R","E","E"],["S","H","E","A","R"],["S","T","E","R","N"]], clues:{across:{"1":"School session","6":"Not heavy","7":"Say yes","8":"Cut wool","9":"Ship's rear"},down:{"1":"Group or rank","2":"Brightness","3":"Be in accord","4":"Cutting force","5":"Serious look"}} },
  { grid:[["F","O","R","C","E"],["O","P","E","R","A"],["R","E","F","E","R"],["C","R","E","S","T"],["E","A","R","T","H"]], clues:{across:{"1":"Power or push","6":"Sung drama","7":"Point to","8":"Wave top","9":"Our planet"},down:{"1":"Strength","2":"Musical theater","3":"Mention","4":"Peak","5":"Soil"}} },
  { grid:[["F","O","R","G","E"],["O","P","E","R","A"],["R","E","F","E","R"],["G","R","E","E","T"],["E","A","R","T","H"]], clues:{across:{"1":"Blacksmith shop","6":"Sung drama","7":"Point to","8":"Say hello","9":"Our planet"},down:{"1":"Shape metal","2":"Musical theater","3":"Mention","4":"Welcome","5":"Soil"}} },
  { grid:[["G","L","A","S","S"],["L","I","G","H","T"],["A","G","R","E","E"],["S","H","E","E","R"],["S","T","E","R","N"]], clues:{across:{"1":"Window material","6":"Not heavy","7":"Say yes","8":"Very thin","9":"Ship's rear"},down:{"1":"Drinking vessel","2":"Brightness","3":"Be in accord","4":"Absolute","5":"Serious look"}} },
  { grid:[["G","R","A","S","S"],["R","I","G","H","T"],["A","G","R","E","E"],["S","H","E","E","R"],["S","T","E","R","N"]], clues:{across:{"1":"Lawn green","6":"Correct","7":"Say yes","8":"Very thin","9":"Ship's rear"},down:{"1":"Yard covering","2":"Not left","3":"Be in accord","4":"Absolute","5":"Serious look"}} },
  { grid:[["Q","U","O","T","E"],["U","L","T","R","A"],["O","T","H","E","R"],["T","R","E","A","T"],["E","A","R","T","H"]], clues:{across:{"1":"Repeat words","6":"Extreme","7":"Different one","8":"Special reward","9":"Our planet"},down:{"1":"Price estimate","2":"Beyond","3":"Alternative","4":"Pay for someone","5":"Soil"}} },
  { grid:[["T","R","U","S","T"],["R","A","N","C","H"],["U","N","D","E","R"],["S","C","E","N","E"],["T","H","R","E","E"]], clues:{across:{"1":"Believe in","6":"Cattle farm","7":"Below","8":"Movie setting","9":"After two"},down:{"1":"Confidence","2":"Western estate","3":"Beneath","4":"Location","5":"A prime number"}} },
  { grid:[["B","U","R","S","T"],["U","N","I","T","E"],["R","I","V","E","R"],["S","T","E","A","M"],["T","E","R","M","S"]], clues:{across:{"1":"Pop suddenly","6":"Join together","7":"Flowing water","8":"Hot vapor","9":"Conditions"},down:{"1":"Sudden break","2":"Come as one","3":"Stream's big sibling","4":"Boiling water output","5":"Agreement words"}} },
];

function getPuzzleIndexForDate(dateStr) {
  // dateStr is YYYY-MM-DD; replicate client-side getTodayIndex() which uses en-US locale date (M/D/YYYY)
  const parts = dateStr.split('-');
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  const year = parseInt(parts[0], 10);
  const d = `${month}/${day}/${year}`;
  let hash = 0;
  for (let i = 0; i < d.length; i++) {
    hash = ((hash << 5) - hash) + d.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % PUZZLES.length;
}

function getPuzzleForDate(dateStr) {
  const idx = getPuzzleIndexForDate(dateStr);
  return { ...PUZZLES[idx], index: idx };
}

module.exports = { PUZZLES, getPuzzleForDate, getPuzzleIndexForDate };
