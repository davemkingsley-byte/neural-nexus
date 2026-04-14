// Connections puzzle data
// Each puzzle has 4 groups of 4 words, ordered by difficulty (0=yellow/easiest → 3=purple/hardest)

const PUZZLES = [
  {
    groups: [
      { name: 'Planets', words: ['MARS', 'VENUS', 'SATURN', 'JUPITER'], difficulty: 0 },
      { name: 'Candy bars', words: ['SNICKERS', 'TWIX', 'BOUNTY', 'MILKY WAY'], difficulty: 1 },
      { name: 'Greek gods', words: ['APOLLO', 'HERMES', 'ATHENA', 'POSEIDON'], difficulty: 2 },
      { name: '___ ring', words: ['BOXING', 'DIAMOND', 'TREE', 'PHONE'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Colors', words: ['CORAL', 'IVORY', 'JADE', 'AMBER'], difficulty: 0 },
      { name: 'Things with keys', words: ['PIANO', 'KEYBOARD', 'MAP', 'LOCK'], difficulty: 1 },
      { name: 'Taylor Swift albums', words: ['FOLKLORE', 'REPUTATION', 'MIDNIGHTS', 'EVERMORE'], difficulty: 2 },
      { name: '___stone', words: ['LIME', 'KEY', 'MILE', 'CORNER'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Breakfast foods', words: ['WAFFLE', 'PANCAKE', 'OATMEAL', 'CEREAL'], difficulty: 0 },
      { name: 'Card games', words: ['POKER', 'BRIDGE', 'HEARTS', 'SOLITAIRE'], difficulty: 1 },
      { name: 'Things that are flat', words: ['TIRE', 'NOTE', 'SCREEN', 'IRON'], difficulty: 2 },
      { name: 'Hidden body parts', words: ['ELBOW', 'SHOULDER', 'SHIN', 'PALM'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Fruits', words: ['MANGO', 'PEACH', 'PLUM', 'CHERRY'], difficulty: 0 },
      { name: 'Music genres', words: ['JAZZ', 'BLUES', 'PUNK', 'SOUL'], difficulty: 1 },
      { name: 'Things with strings', words: ['GUITAR', 'PUPPET', 'KITE', 'BOW'], difficulty: 2 },
      { name: 'Double ___', words: ['DUTCH', 'TAKE', 'CHECK', 'AGENT'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Weather', words: ['RAIN', 'SNOW', 'HAIL', 'SLEET'], difficulty: 0 },
      { name: 'Board games', words: ['CHESS', 'RISK', 'CLUE', 'LIFE'], difficulty: 1 },
      { name: 'Things that run', words: ['FAUCET', 'NOSE', 'STOCKINGS', 'ENGINE'], difficulty: 2 },
      { name: 'Prince ___', words: ['WILLIAM', 'CHARMING', 'HARRY', 'ALBERT'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Dog breeds', words: ['POODLE', 'BEAGLE', 'BOXER', 'HUSKY'], difficulty: 0 },
      { name: 'Computer parts', words: ['MOUSE', 'CHIP', 'MONITOR', 'DRIVER'], difficulty: 1 },
      { name: 'Things that stick', words: ['GLUE', 'TAPE', 'VELCRO', 'MAGNET'], difficulty: 2 },
      { name: 'Poker terms', words: ['FLUSH', 'FOLD', 'RAISE', 'BLIND'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Vegetables', words: ['CARROT', 'CELERY', 'PEPPER', 'ONION'], difficulty: 0 },
      { name: 'Dance styles', words: ['WALTZ', 'TANGO', 'SALSA', 'SWING'], difficulty: 1 },
      { name: 'Things with teeth', words: ['COMB', 'SAW', 'GEAR', 'ZIPPER'], difficulty: 2 },
      { name: '___ break', words: ['SPRING', 'LUNCH', 'JAIL', 'DAY'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Ocean creatures', words: ['WHALE', 'DOLPHIN', 'OCTOPUS', 'SHARK'], difficulty: 0 },
      { name: 'Currencies', words: ['POUND', 'MARK', 'CROWN', 'BUCK'], difficulty: 1 },
      { name: 'Things that crash', words: ['WAVE', 'PARTY', 'MARKET', 'COMPUTER'], difficulty: 2 },
      { name: 'Royal ___', words: ['FLUSH', 'BLUE', 'FAMILY', 'JELLY'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Footwear', words: ['BOOT', 'SANDAL', 'SLIPPER', 'SNEAKER'], difficulty: 0 },
      { name: 'Types of shot', words: ['FREE THROW', 'ESPRESSO', 'VACCINE', 'MUGSHOT'], difficulty: 1 },
      { name: 'Things with rings', words: ['SATURN', 'BINDER', 'CIRCUS', 'PHONE'], difficulty: 2 },
      { name: 'Silent letters', words: ['KNIGHT', 'PSALM', 'GNOME', 'WRECK'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Kitchen tools', words: ['WHISK', 'LADLE', 'TONGS', 'GRATER'], difficulty: 0 },
      { name: 'Things that bloom', words: ['ROSE', 'TULIP', 'DAISY', 'LILY'], difficulty: 1 },
      { name: 'Types of wave', words: ['HEAT', 'RADIO', 'SHOCK', 'SOUND'], difficulty: 2 },
      { name: '___ house', words: ['WARE', 'GREEN', 'FIRE', 'POWER'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Ball sports', words: ['TENNIS', 'SOCCER', 'GOLF', 'CRICKET'], difficulty: 0 },
      { name: 'Shades of blue', words: ['NAVY', 'SKY', 'ROYAL', 'TEAL'], difficulty: 1 },
      { name: 'Things with caps', words: ['BOTTLE', 'MUSHROOM', 'PEN', 'KNEE'], difficulty: 2 },
      { name: 'Hidden animals', words: ['COWBOY', 'CATALOG', 'THERAPY', 'STAMPEDE'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Tree types', words: ['OAK', 'PINE', 'MAPLE', 'BIRCH'], difficulty: 0 },
      { name: 'Pasta shapes', words: ['PENNE', 'RIGATONI', 'FUSILLI', 'FARFALLE'], difficulty: 1 },
      { name: 'Things you cast', words: ['SPELL', 'SHADOW', 'DOUBT', 'VOTE'], difficulty: 2 },
      { name: 'Famous Johns', words: ['LEGEND', 'WICK', 'LENNON', 'OLIVER'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Metals', words: ['GOLD', 'SILVER', 'COPPER', 'IRON'], difficulty: 0 },
      { name: 'Card suits', words: ['HEART', 'DIAMOND', 'CLUB', 'SPADE'], difficulty: 1 },
      { name: 'Things that sink', words: ['SHIP', 'PUTT', 'FEELING', 'TEETH'], difficulty: 2 },
      { name: '___ fish', words: ['SWORD', 'BLOW', 'CAT', 'STAR'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Farm animals', words: ['COW', 'PIG', 'CHICKEN', 'GOAT'], difficulty: 0 },
      { name: 'Types of chart', words: ['BAR', 'PIE', 'LINE', 'SCATTER'], difficulty: 1 },
      { name: 'Things that pop', words: ['BALLOON', 'CORN', 'BUBBLE', 'COLLAR'], difficulty: 2 },
      { name: 'Famous Michaels', words: ['JORDAN', 'JACKSON', 'SCOTT', 'ANGELO'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Berries', words: ['BLUEBERRY', 'RASPBERRY', 'STRAWBERRY', 'BLACKBERRY'], difficulty: 0 },
      { name: 'Things in a wallet', words: ['CASH', 'CARD', 'LICENSE', 'RECEIPT'], difficulty: 1 },
      { name: 'Things that bounce', words: ['BALL', 'CHECK', 'IDEA', 'LIGHT'], difficulty: 2 },
      { name: 'Phone brands', words: ['APPLE', 'PIXEL', 'GALAXY', 'MOTOROLA'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Spices', words: ['CUMIN', 'PAPRIKA', 'THYME', 'OREGANO'], difficulty: 0 },
      { name: 'Zodiac signs', words: ['LEO', 'ARIES', 'LIBRA', 'VIRGO'], difficulty: 1 },
      { name: 'Things with scales', words: ['FISH', 'DRAGON', 'PIANO', 'JUSTICE'], difficulty: 2 },
      { name: 'Hidden colors', words: ['PINKY', 'REDNESS', 'GOLDFISH', 'BLUEPOINT'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Pizza toppings', words: ['PEPPERONI', 'MUSHROOM', 'OLIVE', 'SAUSAGE'], difficulty: 0 },
      { name: 'Types of coat', words: ['TRENCH', 'RAIN', 'FUR', 'SUGAR'], difficulty: 1 },
      { name: 'Things that roll', words: ['DICE', 'THUNDER', 'CREDITS', 'WAVE'], difficulty: 2 },
      { name: 'Rock ___', words: ['BOTTOM', 'STAR', 'CLIMB', 'BAND'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Ice cream flavors', words: ['VANILLA', 'CHOCOLATE', 'PISTACHIO', 'CARAMEL'], difficulty: 0 },
      { name: 'Types of room', words: ['LIVING', 'BATH', 'BED', 'DINING'], difficulty: 1 },
      { name: 'Things that glow', words: ['EMBER', 'FIREFLY', 'NEON', 'STAR'], difficulty: 2 },
      { name: 'Hidden fruits', words: ['APPLAUD', 'FIGMENT', 'APELIKE', 'PLUMBER'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Nuts', words: ['WALNUT', 'ALMOND', 'CASHEW', 'PECAN'], difficulty: 0 },
      { name: 'Things at a circus', words: ['CLOWN', 'TRAPEZE', 'LION', 'TENT'], difficulty: 1 },
      { name: 'Things that spread', words: ['BUTTER', 'RUMOR', 'FIRE', 'NEWS'], difficulty: 2 },
      { name: '___ fly', words: ['BAR', 'MAY', 'BUTTER', 'FIRE'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Gems', words: ['RUBY', 'EMERALD', 'TOPAZ', 'SAPPHIRE'], difficulty: 0 },
      { name: 'Card game terms', words: ['DEAL', 'HAND', 'TRICK', 'DECK'], difficulty: 1 },
      { name: 'Things that spin', words: ['TOP', 'WHEEL', 'RECORD', 'DRYER'], difficulty: 2 },
      { name: 'Super ___', words: ['HERO', 'MARKET', 'NATURAL', 'BOWL'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Body of water', words: ['LAKE', 'RIVER', 'OCEAN', 'POND'], difficulty: 0 },
      { name: 'Musical instruments', words: ['DRUM', 'FLUTE', 'HARP', 'TRUMPET'], difficulty: 1 },
      { name: 'Things that tick', words: ['CLOCK', 'BOMB', 'BOX', 'INSECT'], difficulty: 2 },
      { name: 'Back ___', words: ['FIRE', 'BONE', 'YARD', 'TRACK'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Desserts', words: ['CAKE', 'BROWNIE', 'COOKIE', 'PUDDING'], difficulty: 0 },
      { name: 'Types of test', words: ['BLOOD', 'STRESS', 'TASTE', 'EYE'], difficulty: 1 },
      { name: 'Things with heads', words: ['NAIL', 'BEER', 'COIN', 'LETTUCE'], difficulty: 2 },
      { name: '___ light', words: ['FLASH', 'HIGH', 'MOON', 'SPOT'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Continents', words: ['AFRICA', 'EUROPE', 'ASIA', 'ANTARCTICA'], difficulty: 0 },
      { name: 'Things on a desk', words: ['LAMP', 'MONITOR', 'STAPLER', 'CALENDAR'], difficulty: 1 },
      { name: 'Things that drop', words: ['BEAT', 'ANCHOR', 'NAME', 'JAW'], difficulty: 2 },
      { name: 'Gold ___', words: ['MINE', 'RUSH', 'FISH', 'DIGGER'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Flowers', words: ['ORCHID', 'SUNFLOWER', 'VIOLET', 'PEONY'], difficulty: 0 },
      { name: 'Things in a gym', words: ['BENCH', 'RACK', 'BAR', 'RING'], difficulty: 1 },
      { name: 'Things that set', words: ['SUN', 'TABLE', 'BONE', 'RECORD'], difficulty: 2 },
      { name: 'Lip ___', words: ['STICK', 'SYNC', 'SERVICE', 'BALM'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Cheese types', words: ['BRIE', 'CHEDDAR', 'GOUDA', 'FETA'], difficulty: 0 },
      { name: 'Olympic sports', words: ['FENCING', 'ROWING', 'DIVING', 'ARCHERY'], difficulty: 1 },
      { name: 'Things with bridges', words: ['NOSE', 'GUITAR', 'TOOTH', 'SHIP'], difficulty: 2 },
      { name: 'Blind ___', words: ['SPOT', 'DATE', 'FOLD', 'SIDE'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Herbs', words: ['BASIL', 'MINT', 'SAGE', 'DILL'], difficulty: 0 },
      { name: 'Things in space', words: ['COMET', 'NEBULA', 'QUASAR', 'PULSAR'], difficulty: 1 },
      { name: 'Things that bark', words: ['DOG', 'TREE', 'SEAL', 'SERGEANT'], difficulty: 2 },
      { name: '___ ball', words: ['BASKET', 'SNOW', 'EYE', 'CRYSTAL'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Dances', words: ['SAMBA', 'RUMBA', 'FOXTROT', 'CHA-CHA'], difficulty: 0 },
      { name: 'Types of triangle', words: ['LOVE', 'BERMUDA', 'RIGHT', 'GOLDEN'], difficulty: 1 },
      { name: 'Things with wings', words: ['PLANE', 'STAGE', 'BUILDING', 'ANGEL'], difficulty: 2 },
      { name: 'Apple ___', words: ['SAUCE', 'PIE', 'JACK', 'SEED'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Countries', words: ['CHILE', 'TURKEY', 'JORDAN', 'CHAD'], difficulty: 0 },
      { name: 'Things with tails', words: ['KITE', 'COAT', 'COMET', 'COCKTAIL'], difficulty: 1 },
      { name: 'Things that break', words: ['ICE', 'NEWS', 'DAWN', 'SILENCE'], difficulty: 2 },
      { name: 'Hot ___', words: ['DOG', 'SAUCE', 'SPRING', 'SHOT'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Sandwiches', words: ['CLUB', 'WRAP', 'SUB', 'PANINI'], difficulty: 0 },
      { name: 'Things with bands', words: ['WEDDING', 'ROCK', 'RUBBER', 'WATCH'], difficulty: 1 },
      { name: 'Things that leak', words: ['FAUCET', 'SECRET', 'ROOF', 'BATTERY'], difficulty: 2 },
      { name: 'Paper ___', words: ['WEIGHT', 'CLIP', 'TRAIL', 'BACK'], difficulty: 3 }
    ]
  },
  {
    groups: [
      { name: 'Pasta', words: ['RAVIOLI', 'LINGUINE', 'GNOCCHI', 'TORTELLINI'], difficulty: 0 },
      { name: 'Things with nets', words: ['BASKET', 'TENNIS', 'SPIDER', 'FISHING'], difficulty: 1 },
      { name: 'Things that hang', words: ['PICTURE', 'JURY', 'CLOTHES', 'BALANCE'], difficulty: 2 },
      { name: 'Iron ___', words: ['MAN', 'CURTAIN', 'MAIDEN', 'CLAD'], difficulty: 3 }
    ]
  },
];

function getPuzzleIndexForDate(dateStr) {
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
  const puzzle = PUZZLES[idx];

  // Shuffle the 16 words deterministically by date
  const allWords = [];
  puzzle.groups.forEach((g, gi) => {
    g.words.forEach(w => allWords.push({ word: w, group: gi }));
  });

  // Seeded shuffle using date hash
  let seed = 0;
  for (let i = 0; i < dateStr.length; i++) {
    seed = ((seed << 5) - seed) + dateStr.charCodeAt(i);
    seed |= 0;
  }
  function nextSeed() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  }
  for (let i = allWords.length - 1; i > 0; i--) {
    const j = nextSeed() % (i + 1);
    [allWords[i], allWords[j]] = [allWords[j], allWords[i]];
  }

  return {
    index: idx,
    groups: puzzle.groups,
    shuffledWords: allWords.map(w => w.word)
  };
}

module.exports = { PUZZLES, getPuzzleForDate, getPuzzleIndexForDate };
