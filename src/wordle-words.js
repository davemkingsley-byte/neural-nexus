const fs = require('fs');
const path = require('path');

// Curated answer words - common 5-letter English words people actually know
const ANSWERS = [
  'about','above','abuse','actor','acute','admit','adopt','adult','after','again',
  'agent','agree','ahead','alarm','album','alert','alien','align','alive','alley',
  'allow','alone','along','alter','among','angel','anger','angle','angry','ankle',
  'apple','apply','arena','argue','arise','armor','array','aside','asset','atlas',
  'avoid','award','aware','badge','badly','baker','basic','basis','batch','beach',
  'beard','beast','begin','being','below','bench','berry','birth','black','blade',
  'blame','bland','blank','blast','blaze','bleed','blend','bless','blind','block',
  'blood','bloom','blown','board','bones','bonus','booth','bound','brain','brand',
  'brave','bread','break','breed','brick','bride','brief','bring','broad','broke',
  'brook','brown','brush','buddy','build','bunch','burst','buyer','cabin','cable',
  'candy','cargo','carry','catch','cause','cedar','chain','chair','chalk','champ',
  'chaos','charm','chart','chase','cheap','check','cheek','cheer','chess','chest',
  'chief','child','chill','china','chose','chunk','civic','civil','claim','clash',
  'class','clean','clear','clerk','click','cliff','climb','cling','clock','clone',
  'close','cloth','cloud','coach','coast','color','comet','comic','coral','could',
  'count','court','cover','crack','craft','crane','crash','crazy','cream','crisp',
  'cross','crowd','crown','crush','curve','cycle','daily','dance','death','debut',
  'delay','delta','demon','dense','depot','depth','derby','devil','diary','dirty',
  'donor','doubt','dough','draft','drain','drama','drank','drawn','dream','dress',
  'dried','drift','drill','drink','drive','drone','drown','dying','eager','eagle',
  'early','earth','eight','elder','elect','elite','email','ember','empty','enemy',
  'enjoy','enter','equal','error','essay','event','every','exact','exile','exist',
  'extra','faint','fairy','faith','false','fancy','fatal','favor','feast','fence',
  'fewer','fiber','field','fifth','fifty','fight','final','first','fixed','flame',
  'flash','fleet','flesh','float','flood','floor','flora','flour','fluid','flush',
  'flute','focal','focus','force','forge','forth','forum','found','frame','frank',
  'fraud','fresh','front','froze','fruit','fully','fungi','gauge','ghost','giant',
  'given','glass','globe','gloom','glory','gloss','glove','grace','grade','grain',
  'grand','grant','grape','grasp','grass','grave','great','green','greet','grief',
  'grill','grind','gross','group','grove','grown','guard','guess','guest','guide',
  'guild','guilt','habit','happy','harsh','haven','heart','heavy','hedge','hello',
  'hence','honey','honor','horse','hotel','house','human','humor','hurry','hyper',
  'ideal','image','imply','index','indie','inner','input','intro','issue','ivory',
  'jewel','joint','joker','judge','juice','knock','known','label','lance','large',
  'laser','later','laugh','layer','learn','lease','leave','legal','lemon','level',
  'light','limit','linen','liver','local','logic','loose','lover','lower','loyal',
  'lucky','lunch','lunar','lying','magic','major','maker','manor','maple','march',
  'match','mayor','meant','media','mercy','merge','merit','messy','metal','meter',
  'midst','might','minor','minus','mixed','model','money','month','moral','mount',
  'mouse','mouth','movie','muddy','music','naive','nerve','never','newly','night',
  'noble','noise','north','noted','novel','nurse','nylon','occur','ocean','offer',
  'often','olive','onset','opera','orbit','order','organ','other','outer','owner',
  'oxide','ozone','paint','panel','panic','paper','party','pasta','patch','pause',
  'peace','peach','pearl','penny','phase','phone','photo','piano','piece','pilot',
  'pinch','pixel','pizza','place','plain','plane','plant','plate','plaza','plead',
  'plumb','plume','point','polar','porch','pound','power','press','price','pride',
  'prime','print','prior','prize','probe','prone','proof','proud','prove','proxy',
  'pulse','punch','pupil','purse','queen','query','quest','queue','quick','quiet',
  'quite','quota','quote','radar','radio','raise','rally','ranch','range','rapid',
  'ratio','reach','ready','realm','rebel','refer','reign','relax','relay','reply',
  'rider','ridge','rifle','right','rigid','risky','rival','river','robot','rocky',
  'rouge','rough','round','route','royal','rugby','rural','saint','salad','sauce',
  'scale','scare','scene','scent','scope','score','scout','screw','sedan','sense',
  'serve','setup','seven','shade','shaft','shake','shall','shame','shape','share',
  'shark','sharp','shear','sheet','shelf','shell','shift','shine','shirt','shock',
  'shoot','shore','short','shout','shown','sight','silly','since','sixth','sixty',
  'sized','skill','skull','slang','sleep','slice','slide','slope','smart','smell',
  'smile','smoke','snake','solar','solid','solve','sorry','south','space','spare',
  'spark','speak','spear','speed','spend','spent','spice','spill','spine','spoke',
  'spoon','sport','spray','squad','stack','staff','stage','stain','stake','stale',
  'stall','stamp','stand','stare','stark','start','state','steak','steal','steam',
  'steel','steep','steer','stern','stick','stiff','still','stock','stone','stood',
  'store','storm','story','stove','strap','straw','strip','stuck','study','stuff',
  'style','suite','sunny','super','surge','swamp','swear','sweep','sweet','swept',
  'swift','swing','sword','syrup','table','taste','teach','teeth','tempo','tense',
  'terms','theft','theme','there','thick','thief','thing','think','third','thorn',
  'those','three','threw','throw','thumb','tidal','tiger','tight','timer','tired',
  'titan','title','today','token','topic','total','touch','tough','towel','tower',
  'toxic','trace','track','trade','trail','train','trait','trash','treat','trend',
  'trial','tribe','trick','tried','troop','truck','truly','trunk','trust','truth',
  'tumor','tuner','twice','twist','ultra','uncle','under','union','unite','unity',
  'until','upper','upset','urban','usage','usual','valid','value','vault','venue',
  'verse','video','vigor','viral','virus','visit','vista','vital','vivid','vocal',
  'voice','voter','wagon','waste','watch','water','weary','weave','weird','whale',
  'wheat','wheel','where','which','while','white','whole','whose','wider','witch',
  'woman','world','worry','worse','worst','worth','would','wound','wrath','wrist',
  'wrote','yacht','yield','young','youth','zebra'
];

// Load ALL 5-letter words from bundled dictionary as valid guesses
const VALID_GUESSES = new Set(ANSWERS);
try {
  const dictFile = path.join(__dirname, 'dict5.txt');
  if (fs.existsSync(dictFile)) {
    const words = fs.readFileSync(dictFile, 'utf8').trim().split('\n');
    words.forEach(w => VALID_GUESSES.add(w.trim().toLowerCase()));
    console.log(`Wordle: ${VALID_GUESSES.size} valid guess words loaded from dict5.txt`);
  }
} catch(e) { console.error('Dict load error:', e.message); }

function getTodayWord() {
  const today = new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).split(',')[0];
  let hash = 0;
  for (let i = 0; i < today.length; i++) {
    hash = ((hash << 5) - hash) + today.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % ANSWERS.length;
  return { word: ANSWERS[idx], date: today };
}

function getWordForDate(dateStr) {
  // dateStr in YYYY-MM-DD format (same as en-CA locale output)
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = ((hash << 5) - hash) + dateStr.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % ANSWERS.length;
  return ANSWERS[idx];
}

function isValidGuess(word) {
  return VALID_GUESSES.has(word.toLowerCase());
}

module.exports = { getTodayWord, getWordForDate, isValidGuess, ANSWERS, VALID_GUESSES };
