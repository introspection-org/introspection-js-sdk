// scripts/bank-server.ts
import { createServer } from "node:http";

// lib/question-types.ts
var GENRES = [
  "music",
  "film",
  "sport",
  "science",
  "history",
  "geography"
];
var q = (id, genre, region, difficulty, text2, answer, aliases = []) => ({ id, genre, region, difficulty, text: text2, answer, aliases });

// lib/questions-more.ts
var MORE_QUESTIONS = [
  // Music
  q(
    "mu-13",
    "music",
    "global",
    1,
    "Which singer is known as the King of Rock and Roll?",
    "Elvis Presley",
    ["Elvis", "Presley"]
  ),
  q(
    "mu-14",
    "music",
    "global",
    1,
    "Which singer released the 1982 album Thriller?",
    "Michael Jackson",
    ["Jackson", "MJ"]
  ),
  q(
    "mu-15",
    "music",
    "global",
    1,
    "Which instrument has 88 keys in its standard form?",
    "Piano",
    ["The piano"]
  ),
  q(
    "mu-16",
    "music",
    "global",
    1,
    "Which Swedish group sang Dancing Queen?",
    "ABBA"
  ),
  q(
    "mu-17",
    "music",
    "global",
    2,
    "Which band released the album The Dark Side of the Moon?",
    "Pink Floyd"
  ),
  q(
    "mu-18",
    "music",
    "global",
    2,
    "Which singer released the albums 19, 21, 25 and 30?",
    "Adele"
  ),
  q(
    "mu-19",
    "music",
    "global",
    2,
    "Which Jamaican musician recorded No Woman, No Cry with the Wailers?",
    "Bob Marley",
    ["Marley"]
  ),
  q(
    "mu-20",
    "music",
    "global",
    2,
    "Which band was fronted by Mick Jagger?",
    "The Rolling Stones",
    ["Rolling Stones", "Stones", "The Stones"]
  ),
  q(
    "mu-21",
    "music",
    "global",
    3,
    "Which composer wrote the Moonlight Sonata?",
    "Ludwig van Beethoven",
    ["Beethoven"]
  ),
  q(
    "mu-22",
    "music",
    "global",
    3,
    "Which band's 1991 album Nevermind featured Smells Like Teen Spirit?",
    "Nirvana"
  ),
  q(
    "mu-23",
    "music",
    "global",
    3,
    "How many lines make up a standard musical staff?",
    "Five",
    ["5"]
  ),
  q(
    "mu-24",
    "music",
    "global",
    3,
    "Which singer was born Stefani Germanotta?",
    "Lady Gaga",
    ["Gaga"]
  ),
  q(
    "mu-25",
    "music",
    "global",
    4,
    "Which composer wrote the Brandenburg Concertos?",
    "Johann Sebastian Bach",
    ["Bach", "J.S. Bach", "JS Bach"]
  ),
  q(
    "mu-26",
    "music",
    "global",
    4,
    "Which Italian composer wrote the opera La Traviata?",
    "Giuseppe Verdi",
    ["Verdi"]
  ),
  q(
    "mu-27",
    "music",
    "global",
    4,
    "Which Russian composer wrote the ballet Swan Lake?",
    "Pyotr Ilyich Tchaikovsky",
    ["Tchaikovsky"]
  ),
  q(
    "mu-28",
    "music",
    "global",
    5,
    "Which composer wrote the opera cycle The Ring of the Nibelung?",
    "Richard Wagner",
    ["Wagner"]
  ),
  q(
    "mu-29",
    "music",
    "global",
    5,
    "Which French composer wrote Bolero?",
    "Maurice Ravel",
    ["Ravel"]
  ),
  q(
    "mu-30",
    "music",
    "global",
    5,
    "Which composer wrote the ballet The Rite of Spring?",
    "Igor Stravinsky",
    ["Stravinsky"]
  ),
  q(
    "mu-31",
    "music",
    "global",
    5,
    "Which jazz saxophonist recorded the album A Love Supreme?",
    "John Coltrane",
    ["Coltrane"]
  ),
  q(
    "mu-32",
    "music",
    "au",
    1,
    "Which Australian singer had a hit with Can't Get You Out of My Head?",
    "Kylie Minogue",
    ["Kylie", "Minogue"]
  ),
  q(
    "mu-33",
    "music",
    "au",
    3,
    "Which Australian band recorded Beds Are Burning?",
    "Midnight Oil",
    ["The Oils"]
  ),
  q(
    "mu-34",
    "music",
    "au",
    4,
    "Which Australian band had a 1987 hit with Need You Tonight?",
    "INXS"
  ),
  q(
    "mu-35",
    "music",
    "uk",
    2,
    "Which Manchester band released the album (What's the Story) Morning Glory?",
    "Oasis"
  ),
  q(
    "mu-36",
    "music",
    "uk",
    3,
    "Which summer season of classical concerts is held at the Royal Albert Hall?",
    "The Proms",
    ["Proms", "BBC Proms", "The BBC Proms"]
  ),
  q(
    "mu-37",
    "music",
    "uk",
    5,
    "Which English composer wrote the Pomp and Circumstance Marches?",
    "Edward Elgar",
    ["Elgar"]
  ),
  q(
    "mu-38",
    "music",
    "us",
    1,
    "Which American rock singer is nicknamed The Boss?",
    "Bruce Springsteen",
    ["Springsteen"]
  ),
  q(
    "mu-39",
    "music",
    "us",
    2,
    "Which American city is known as the birthplace of jazz?",
    "New Orleans"
  ),
  q(
    "mu-40",
    "music",
    "us",
    4,
    "Which American composer wrote Rhapsody in Blue?",
    "George Gershwin",
    ["Gershwin"]
  ),
  // Film
  q(
    "fi-13",
    "film",
    "global",
    1,
    "In Star Wars, who is revealed to be Luke Skywalker's father?",
    "Darth Vader",
    ["Vader", "Anakin Skywalker", "Anakin"]
  ),
  q(
    "fi-14",
    "film",
    "global",
    1,
    "What kind of animal is Simba in The Lion King?",
    "Lion",
    ["A lion"]
  ),
  q(
    "fi-15",
    "film",
    "global",
    1,
    "Which boy wizard attends Hogwarts in a series of eight films?",
    "Harry Potter",
    ["Potter"]
  ),
  q(
    "fi-16",
    "film",
    "global",
    1,
    "Which 1997 film tells the story of a liner that hits an iceberg?",
    "Titanic"
  ),
  q(
    "fi-17",
    "film",
    "global",
    2,
    "Who directed both Titanic and Avatar?",
    "James Cameron",
    ["Cameron"]
  ),
  q(
    "fi-18",
    "film",
    "global",
    2,
    "In which fictional African country is Black Panther set?",
    "Wakanda"
  ),
  q(
    "fi-19",
    "film",
    "global",
    2,
    "What is the name of the cowboy doll in Toy Story?",
    "Woody",
    ["Sheriff Woody"]
  ),
  q(
    "fi-20",
    "film",
    "global",
    2,
    "Which actor played the title role in Forrest Gump?",
    "Tom Hanks",
    ["Hanks"]
  ),
  q(
    "fi-21",
    "film",
    "global",
    3,
    "Which 1994 film is set in Shawshank State Prison?",
    "The Shawshank Redemption",
    ["Shawshank Redemption", "Shawshank"]
  ),
  q(
    "fi-22",
    "film",
    "global",
    3,
    "Who directed the 1960 film Psycho?",
    "Alfred Hitchcock",
    ["Hitchcock"]
  ),
  q(
    "fi-23",
    "film",
    "global",
    3,
    "Which South Korean film won the Academy Award for Best Picture in 2020?",
    "Parasite"
  ),
  q(
    "fi-24",
    "film",
    "global",
    3,
    "Which composer wrote the scores for Jaws and Star Wars?",
    "John Williams",
    ["Williams"]
  ),
  q(
    "fi-25",
    "film",
    "global",
    4,
    "What is the name of the hotel in The Shining?",
    "The Overlook Hotel",
    ["Overlook Hotel", "Overlook", "The Overlook"]
  ),
  q(
    "fi-26",
    "film",
    "global",
    4,
    "Which Studio Ghibli film follows a girl named Chihiro?",
    "Spirited Away"
  ),
  q(
    "fi-27",
    "film",
    "global",
    4,
    "Which 1939 film won the Academy Award for Best Picture?",
    "Gone with the Wind"
  ),
  q(
    "fi-28",
    "film",
    "global",
    5,
    "Which Swedish director made The Seventh Seal?",
    "Ingmar Bergman",
    ["Bergman"]
  ),
  q(
    "fi-29",
    "film",
    "global",
    5,
    "Which Italian director made La Dolce Vita?",
    "Federico Fellini",
    ["Fellini"]
  ),
  q(
    "fi-30",
    "film",
    "global",
    5,
    "Which film won the first Academy Award for Best Picture?",
    "Wings"
  ),
  q(
    "fi-31",
    "film",
    "global",
    5,
    "Which Soviet director made Battleship Potemkin?",
    "Sergei Eisenstein",
    ["Eisenstein"]
  ),
  q(
    "fi-32",
    "film",
    "au",
    1,
    "Which Australian actor played Wolverine in the X-Men films?",
    "Hugh Jackman",
    ["Jackman"]
  ),
  q(
    "fi-33",
    "film",
    "au",
    3,
    "Which 1994 Australian film follows three drag performers crossing the outback in a bus?",
    "The Adventures of Priscilla, Queen of the Desert",
    ["Priscilla", "Priscilla Queen of the Desert", "Adventures of Priscilla"]
  ),
  q(
    "fi-34",
    "film",
    "au",
    4,
    "In which 1975 Peter Weir film do schoolgirls vanish on Valentine's Day 1900?",
    "Picnic at Hanging Rock",
    ["Hanging Rock"]
  ),
  q(
    "fi-35",
    "film",
    "uk",
    2,
    "Which plasticine duo, an inventor and his dog, were created by Nick Park?",
    "Wallace and Gromit",
    ["Wallace & Gromit"]
  ),
  q(
    "fi-36",
    "film",
    "uk",
    3,
    "Which 1996 Danny Boyle film follows a group of heroin users in Edinburgh?",
    "Trainspotting"
  ),
  q(
    "fi-37",
    "film",
    "uk",
    5,
    "In which Ealing comedy does Alec Guinness play eight members of one family?",
    "Kind Hearts and Coronets"
  ),
  q(
    "fi-38",
    "film",
    "us",
    1,
    "In which US city is the Hollywood district?",
    "Los Angeles",
    ["LA", "L.A."]
  ),
  q(
    "fi-39",
    "film",
    "us",
    2,
    "In which New York City borough is Saturday Night Fever set?",
    "Brooklyn"
  ),
  q(
    "fi-40",
    "film",
    "us",
    4,
    "Which awards, held the night before the Oscars, honour the year's worst films?",
    "The Golden Raspberry Awards",
    [
      "Razzies",
      "Razzie Awards",
      "Golden Raspberry Awards",
      "Golden Raspberries"
    ]
  ),
  // Sport
  q(
    "sp-13",
    "sport",
    "global",
    1,
    "In which sport do players hit a shuttlecock?",
    "Badminton"
  ),
  q(
    "sp-14",
    "sport",
    "global",
    1,
    "How many holes are played in a standard round of golf?",
    "Eighteen",
    ["18"]
  ),
  q(
    "sp-15",
    "sport",
    "global",
    1,
    "How many players does a basketball team have on the court?",
    "Five",
    ["5"]
  ),
  q(
    "sp-16",
    "sport",
    "global",
    1,
    "Which country hosts the Tour de France?",
    "France"
  ),
  q(
    "sp-17",
    "sport",
    "global",
    2,
    "Which Jamaican sprinter holds the men's 100 metres world record?",
    "Usain Bolt",
    ["Bolt"]
  ),
  q(
    "sp-18",
    "sport",
    "global",
    2,
    "In which sport would you use a foil, an epee or a sabre?",
    "Fencing"
  ),
  q(
    "sp-19",
    "sport",
    "global",
    2,
    "How many minutes does a football (soccer) match last, excluding stoppage time?",
    "Ninety",
    ["90"]
  ),
  q(
    "sp-20",
    "sport",
    "global",
    2,
    "Which country has won the most FIFA World Cups?",
    "Brazil"
  ),
  q(
    "sp-21",
    "sport",
    "global",
    3,
    "Which city hosted the 2008 Summer Olympics?",
    "Beijing"
  ),
  q(
    "sp-22",
    "sport",
    "global",
    3,
    "Which boxer called himself The Greatest?",
    "Muhammad Ali",
    ["Ali", "Cassius Clay"]
  ),
  q(
    "sp-23",
    "sport",
    "global",
    3,
    "How many players does a rugby union team have on the field?",
    "Fifteen",
    ["15"]
  ),
  q(
    "sp-24",
    "sport",
    "global",
    3,
    "In golf, what is a score of one under par on a hole called?",
    "Birdie",
    ["A birdie"]
  ),
  q(
    "sp-25",
    "sport",
    "global",
    4,
    "Which country won the first Rugby World Cup, in 1987?",
    "New Zealand",
    ["NZ", "All Blacks", "The All Blacks"]
  ),
  q(
    "sp-26",
    "sport",
    "global",
    4,
    "Which city hosted the 1964 Summer Olympics?",
    "Tokyo"
  ),
  q(
    "sp-27",
    "sport",
    "global",
    4,
    "In which sport is the Stanley Cup contested?",
    "Ice hockey",
    ["Hockey"]
  ),
  q(
    "sp-28",
    "sport",
    "global",
    5,
    "Which Romanian gymnast scored the first perfect 10 at the Olympics, in 1976?",
    "Nadia Comaneci",
    ["Comaneci"]
  ),
  q(
    "sp-29",
    "sport",
    "global",
    5,
    "Which French town hosted the first Winter Olympics, in 1924?",
    "Chamonix",
    ["Chamonix-Mont-Blanc"]
  ),
  q(
    "sp-30",
    "sport",
    "global",
    5,
    "Which American swimmer won seven gold medals at the 1972 Munich Olympics?",
    "Mark Spitz",
    ["Spitz"]
  ),
  q(
    "sp-31",
    "sport",
    "global",
    5,
    "Which team won the first men's Cricket World Cup, in 1975?",
    "The West Indies",
    ["West Indies", "Windies", "The Windies"]
  ),
  q(
    "sp-32",
    "sport",
    "au",
    1,
    "Which horse race is known as the race that stops a nation?",
    "The Melbourne Cup",
    ["Melbourne Cup"]
  ),
  q(
    "sp-33",
    "sport",
    "au",
    3,
    "Which football code is played in the State of Origin series?",
    "Rugby league",
    ["League"]
  ),
  q(
    "sp-34",
    "sport",
    "au",
    4,
    "Which yacht won the America's Cup for Australia in 1983?",
    "Australia II",
    ["Australia 2", "Australia Two"]
  ),
  q(
    "sp-35",
    "sport",
    "uk",
    2,
    "Which London stadium hosts the FA Cup Final?",
    "Wembley",
    ["Wembley Stadium"]
  ),
  q(
    "sp-36",
    "sport",
    "uk",
    3,
    "What is the maximum break in snooker, without a free ball?",
    "147"
  ),
  q(
    "sp-37",
    "sport",
    "uk",
    5,
    "Which racecourse near Liverpool hosts the Grand National?",
    "Aintree"
  ),
  q(
    "sp-38",
    "sport",
    "us",
    1,
    "In which sport is the World Series played?",
    "Baseball"
  ),
  q(
    "sp-39",
    "sport",
    "us",
    2,
    "How many points is a touchdown worth in American football?",
    "Six",
    ["6"]
  ),
  q(
    "sp-40",
    "sport",
    "us",
    4,
    "Which baseball player was nicknamed the Bambino?",
    "Babe Ruth",
    ["Ruth"]
  ),
  // Science
  q(
    "sc-13",
    "science",
    "global",
    1,
    "What is the closest star to Earth?",
    "The Sun",
    ["Sun"]
  ),
  q(
    "sc-14",
    "science",
    "global",
    1,
    "What is the chemical symbol for oxygen?",
    "O"
  ),
  q(
    "sc-15",
    "science",
    "global",
    1,
    "Which organ pumps blood around the body?",
    "Heart",
    ["The heart"]
  ),
  q(
    "sc-16",
    "science",
    "global",
    1,
    "What is the largest planet in the Solar System?",
    "Jupiter"
  ),
  q(
    "sc-17",
    "science",
    "global",
    2,
    "At sea level, at how many degrees Celsius does water boil?",
    "100",
    ["One hundred"]
  ),
  q(
    "sc-18",
    "science",
    "global",
    2,
    "Which scientist developed the theory of relativity?",
    "Albert Einstein",
    ["Einstein"]
  ),
  q(
    "sc-19",
    "science",
    "global",
    2,
    "How many planets are in the Solar System?",
    "Eight",
    ["8"]
  ),
  q(
    "sc-20",
    "science",
    "global",
    2,
    "What is the largest organ of the human body?",
    "Skin",
    ["The skin"]
  ),
  q(
    "sc-21",
    "science",
    "global",
    3,
    "What is the chemical symbol for sodium?",
    "Na"
  ),
  q(
    "sc-22",
    "science",
    "global",
    3,
    "What is the most abundant gas in Earth's atmosphere?",
    "Nitrogen",
    ["N2"]
  ),
  q(
    "sc-23",
    "science",
    "global",
    3,
    "Which planet is closest to the Sun?",
    "Mercury"
  ),
  q(
    "sc-24",
    "science",
    "global",
    3,
    "What is the atomic number of carbon?",
    "Six",
    ["6"]
  ),
  q(
    "sc-25",
    "science",
    "global",
    4,
    "Which scientist discovered penicillin in 1928?",
    "Alexander Fleming",
    ["Fleming"]
  ),
  q(
    "sc-26",
    "science",
    "global",
    4,
    "What is the chemical symbol for potassium?",
    "K"
  ),
  q(
    "sc-27",
    "science",
    "global",
    4,
    "Who was the first woman to win a Nobel Prize?",
    "Marie Curie",
    ["Curie"]
  ),
  q(
    "sc-28",
    "science",
    "global",
    5,
    "What is the SI unit of magnetic flux density?",
    "Tesla",
    ["The tesla"]
  ),
  q(
    "sc-29",
    "science",
    "global",
    5,
    "Which noble gas has the atomic number 10?",
    "Neon"
  ),
  q(
    "sc-30",
    "science",
    "global",
    5,
    "Which physicist formulated the uncertainty principle?",
    "Werner Heisenberg",
    ["Heisenberg"]
  ),
  q(
    "sc-31",
    "science",
    "global",
    5,
    "What is the most abundant element in Earth's crust, by mass?",
    "Oxygen"
  ),
  q(
    "sc-32",
    "science",
    "au",
    1,
    "Which Australian marsupial feeds almost entirely on eucalyptus leaves?",
    "Koala",
    ["The koala"]
  ),
  q(
    "sc-33",
    "science",
    "au",
    3,
    "Which Australian scientist shared the 1945 Nobel Prize for developing penicillin?",
    "Howard Florey",
    ["Florey"]
  ),
  q(
    "sc-34",
    "science",
    "au",
    4,
    "Which deadly jellyfish of northern Australian waters is also called the sea wasp?",
    "Box jellyfish",
    ["Box jelly", "Chironex"]
  ),
  q(
    "sc-35",
    "science",
    "uk",
    2,
    "Which British computer scientist invented the World Wide Web?",
    "Tim Berners-Lee",
    ["Berners-Lee", "Berners Lee"]
  ),
  q(
    "sc-36",
    "science",
    "uk",
    3,
    "Which British naturalist presented Life on Earth and Blue Planet?",
    "David Attenborough",
    ["Attenborough"]
  ),
  q(
    "sc-37",
    "science",
    "uk",
    5,
    "Which Scottish physicist formulated the classical equations of electromagnetism?",
    "James Clerk Maxwell",
    ["Maxwell", "Clerk Maxwell"]
  ),
  q(
    "sc-38",
    "science",
    "us",
    1,
    "Which US space agency landed astronauts on the Moon?",
    "NASA"
  ),
  q(
    "sc-39",
    "science",
    "us",
    2,
    "Which American inventor developed the phonograph?",
    "Thomas Edison",
    ["Edison"]
  ),
  q(
    "sc-40",
    "science",
    "us",
    4,
    "What was the code name of the US project that built the first atomic bombs?",
    "The Manhattan Project",
    ["Manhattan Project", "Manhattan"]
  ),
  // History
  q(
    "hi-13",
    "history",
    "global",
    1,
    "Which ocean liner sank on its maiden voyage in 1912?",
    "Titanic",
    ["RMS Titanic", "The Titanic"]
  ),
  q(
    "hi-14",
    "history",
    "global",
    1,
    "In which year did the First World War begin?",
    "1914"
  ),
  q(
    "hi-15",
    "history",
    "global",
    1,
    "Which Egyptian queen had relationships with Julius Caesar and Mark Antony?",
    "Cleopatra"
  ),
  q(
    "hi-16",
    "history",
    "global",
    1,
    "Which country gave the Statue of Liberty to the United States?",
    "France"
  ),
  q(
    "hi-17",
    "history",
    "global",
    2,
    "Which French emperor was defeated at Waterloo?",
    "Napoleon Bonaparte",
    ["Napoleon", "Bonaparte"]
  ),
  q(
    "hi-18",
    "history",
    "global",
    2,
    "In which year did humans first land on the Moon?",
    "1969"
  ),
  q(
    "hi-19",
    "history",
    "global",
    2,
    "Which ancient civilisation built the pyramids of Giza?",
    "The Ancient Egyptians",
    [
      "Ancient Egyptians",
      "Egyptians",
      "The Egyptians",
      "Ancient Egypt",
      "Egypt"
    ]
  ),
  q(
    "hi-20",
    "history",
    "global",
    2,
    "Who was the first President of the United States?",
    "George Washington",
    ["Washington"]
  ),
  q(
    "hi-21",
    "history",
    "global",
    3,
    "Who founded the Mongol Empire?",
    "Genghis Khan",
    ["Chinggis Khan"]
  ),
  q(
    "hi-22",
    "history",
    "global",
    3,
    "In which city was President John F. Kennedy assassinated?",
    "Dallas"
  ),
  q(
    "hi-23",
    "history",
    "global",
    3,
    "Which South African leader spent 27 years in prison before becoming president?",
    "Nelson Mandela",
    ["Mandela"]
  ),
  q(
    "hi-24",
    "history",
    "global",
    3,
    "Who was the British Prime Minister for most of the Second World War?",
    "Winston Churchill",
    ["Churchill"]
  ),
  q(
    "hi-25",
    "history",
    "global",
    4,
    "Which empire was ruled from Constantinople for about a thousand years after Rome fell in the west?",
    "The Byzantine Empire",
    ["Byzantine Empire", "Byzantine", "Byzantium", "Eastern Roman Empire"]
  ),
  q(
    "hi-26",
    "history",
    "global",
    4,
    "Which dynasty ruled Russia until the revolution of 1917?",
    "The Romanovs",
    ["Romanovs", "Romanov", "House of Romanov"]
  ),
  q(
    "hi-27",
    "history",
    "global",
    4,
    "In which year did Christopher Columbus first reach the Americas?",
    "1492"
  ),
  q(
    "hi-28",
    "history",
    "global",
    5,
    "Which Carthaginian general crossed the Alps with elephants?",
    "Hannibal",
    ["Hannibal Barca"]
  ),
  q(
    "hi-29",
    "history",
    "global",
    5,
    "Which Chinese dynasty built most of the Great Wall as it stands today?",
    "The Ming",
    ["Ming", "Ming dynasty", "The Ming dynasty"]
  ),
  q(
    "hi-30",
    "history",
    "global",
    5,
    "In which year AD is the Western Roman Empire traditionally said to have fallen?",
    "476"
  ),
  q(
    "hi-31",
    "history",
    "global",
    5,
    "Which Aztec emperor ruled when Hernan Cortes arrived in Mexico?",
    "Moctezuma",
    ["Montezuma", "Moctezuma II", "Montezuma II"]
  ),
  q(
    "hi-32",
    "history",
    "au",
    1,
    "Which bushranger wore home-made armour at his last stand at Glenrowan?",
    "Ned Kelly",
    ["Kelly"]
  ),
  q(
    "hi-33",
    "history",
    "au",
    3,
    "Which ship did James Cook command when he reached Australia's east coast in 1770?",
    "HMS Endeavour",
    ["Endeavour", "The Endeavour", "Endeavor"]
  ),
  q(
    "hi-34",
    "history",
    "au",
    4,
    "Which Australian Prime Minister disappeared while swimming in 1967?",
    "Harold Holt",
    ["Holt"]
  ),
  q(
    "hi-35",
    "history",
    "uk",
    2,
    "Which Tudor king had six wives?",
    "Henry VIII",
    ["Henry the Eighth", "Henry 8"]
  ),
  q(
    "hi-36",
    "history",
    "uk",
    3,
    "Which conspirator caught guarding the gunpowder in 1605 is remembered on Bonfire Night?",
    "Guy Fawkes",
    ["Fawkes"]
  ),
  q(
    "hi-37",
    "history",
    "uk",
    5,
    "Which king of Wessex defeated the Danes at the Battle of Edington in 878?",
    "Alfred the Great",
    ["Alfred", "King Alfred"]
  ),
  q(
    "hi-38",
    "history",
    "us",
    1,
    "Which US President was assassinated at Ford's Theatre?",
    "Abraham Lincoln",
    ["Lincoln"]
  ),
  q(
    "hi-39",
    "history",
    "us",
    2,
    "Which civil rights leader gave the I Have a Dream speech?",
    "Martin Luther King Jr.",
    ["Martin Luther King", "MLK", "Dr King"]
  ),
  q(
    "hi-40",
    "history",
    "us",
    4,
    "From which country did the United States buy Alaska in 1867?",
    "Russia"
  ),
  // Geography
  q("ge-13", "geography", "global", 1, "What is the capital of Italy?", "Rome"),
  q(
    "ge-14",
    "geography",
    "global",
    1,
    "What is the tallest mountain in the world?",
    "Mount Everest",
    ["Everest"]
  ),
  q(
    "ge-15",
    "geography",
    "global",
    1,
    "On which continent is Egypt?",
    "Africa"
  ),
  q(
    "ge-16",
    "geography",
    "global",
    1,
    "What is the capital of Germany?",
    "Berlin"
  ),
  q(
    "ge-17",
    "geography",
    "global",
    2,
    "What is the capital of Egypt?",
    "Cairo"
  ),
  q(
    "ge-18",
    "geography",
    "global",
    2,
    "Which is the largest country in the world by area?",
    "Russia"
  ),
  q(
    "ge-19",
    "geography",
    "global",
    2,
    "What is the smallest country in the world by area?",
    "Vatican City",
    ["Vatican", "The Vatican"]
  ),
  q(
    "ge-20",
    "geography",
    "global",
    2,
    "What is the capital of Argentina?",
    "Buenos Aires"
  ),
  q(
    "ge-21",
    "geography",
    "global",
    3,
    "What is the capital of Turkey?",
    "Ankara"
  ),
  q(
    "ge-22",
    "geography",
    "global",
    3,
    "What is the capital of Brazil?",
    "Brasilia"
  ),
  q(
    "ge-23",
    "geography",
    "global",
    3,
    "Which strait separates Spain from Morocco?",
    "The Strait of Gibraltar",
    ["Strait of Gibraltar", "Gibraltar"]
  ),
  q(
    "ge-24",
    "geography",
    "global",
    3,
    "What is the capital of Switzerland?",
    "Bern",
    ["Berne"]
  ),
  q(
    "ge-25",
    "geography",
    "global",
    4,
    "Which mountain range is the traditional boundary between Europe and Asia?",
    "The Urals",
    ["Urals", "Ural Mountains", "The Ural Mountains"]
  ),
  q(
    "ge-26",
    "geography",
    "global",
    4,
    "What is the capital of Nigeria?",
    "Abuja"
  ),
  q(
    "ge-27",
    "geography",
    "global",
    4,
    "Which is the largest lake in Africa?",
    "Lake Victoria",
    ["Victoria"]
  ),
  q(
    "ge-28",
    "geography",
    "global",
    5,
    "What is the capital of Bhutan?",
    "Thimphu"
  ),
  q(
    "ge-29",
    "geography",
    "global",
    5,
    "Which is the deepest lake in the world?",
    "Lake Baikal",
    ["Baikal"]
  ),
  q(
    "ge-30",
    "geography",
    "global",
    5,
    "What is the capital of Mongolia?",
    "Ulaanbaatar",
    ["Ulan Bator"]
  ),
  q(
    "ge-31",
    "geography",
    "global",
    5,
    "What is the capital of Burkina Faso?",
    "Ouagadougou"
  ),
  q(
    "ge-32",
    "geography",
    "au",
    1,
    "What is the great sandstone monolith in central Australia called?",
    "Uluru",
    ["Ayers Rock"]
  ),
  q(
    "ge-33",
    "geography",
    "au",
    3,
    "Which Australian state is an island?",
    "Tasmania"
  ),
  q(
    "ge-34",
    "geography",
    "au",
    4,
    "What is the capital of the Northern Territory?",
    "Darwin"
  ),
  q(
    "ge-35",
    "geography",
    "uk",
    2,
    "What is the capital of Scotland?",
    "Edinburgh"
  ),
  q(
    "ge-36",
    "geography",
    "uk",
    3,
    "What is the highest mountain in the British Isles?",
    "Ben Nevis"
  ),
  q(
    "ge-37",
    "geography",
    "uk",
    5,
    "Which is the longest river in the United Kingdom?",
    "The Severn",
    ["Severn", "River Severn", "The River Severn"]
  ),
  q(
    "ge-38",
    "geography",
    "us",
    1,
    "Which US state is made up entirely of islands in the Pacific?",
    "Hawaii"
  ),
  q(
    "ge-39",
    "geography",
    "us",
    2,
    "What is the capital of California?",
    "Sacramento"
  ),
  q(
    "ge-40",
    "geography",
    "us",
    4,
    "Which river forms the border between Texas and Mexico?",
    "The Rio Grande",
    ["Rio Grande"]
  )
];

// lib/questions.ts
var QUESTIONS = [
  // Music
  q(
    "mu-01",
    "music",
    "global",
    1,
    "Which band released the album Abbey Road?",
    "The Beatles",
    ["Beatles"]
  ),
  q(
    "mu-02",
    "music",
    "global",
    1,
    "Which singer is known as the Queen of Pop?",
    "Madonna"
  ),
  q(
    "mu-03",
    "music",
    "global",
    2,
    "How many strings does a standard violin have?",
    "Four",
    ["4"]
  ),
  q(
    "mu-04",
    "music",
    "global",
    2,
    "Which composer wrote The Four Seasons?",
    "Antonio Vivaldi",
    ["Vivaldi"]
  ),
  q(
    "mu-05",
    "music",
    "global",
    3,
    "Which band's frontman was Freddie Mercury?",
    "Queen"
  ),
  q(
    "mu-06",
    "music",
    "global",
    3,
    "Which instrument did jazz musician Miles Davis play?",
    "Trumpet",
    ["The trumpet"]
  ),
  q(
    "mu-07",
    "music",
    "global",
    4,
    "Which composer wrote the opera The Magic Flute?",
    "Wolfgang Amadeus Mozart",
    ["Mozart"]
  ),
  q(
    "mu-08",
    "music",
    "global",
    5,
    "Which composer wrote the piano suite Pictures at an Exhibition?",
    "Modest Mussorgsky",
    ["Mussorgsky"]
  ),
  q(
    "mu-09",
    "music",
    "au",
    2,
    "Which Australian band recorded Highway to Hell?",
    "AC/DC",
    ["ACDC", "AC DC"]
  ),
  q(
    "mu-10",
    "music",
    "au",
    3,
    "Which Australian band had a hit with Down Under?",
    "Men at Work"
  ),
  q(
    "mu-11",
    "music",
    "uk",
    2,
    "Which city did The Beatles come from?",
    "Liverpool"
  ),
  q(
    "mu-12",
    "music",
    "us",
    3,
    "Which US city is known as the home of country music?",
    "Nashville"
  ),
  // Film
  q(
    "fi-01",
    "film",
    "global",
    1,
    "Which film features a shark terrorising Amity Island?",
    "Jaws"
  ),
  q(
    "fi-02",
    "film",
    "global",
    1,
    "Who directed Jurassic Park?",
    "Steven Spielberg",
    ["Spielberg"]
  ),
  q(
    "fi-03",
    "film",
    "global",
    2,
    "In The Matrix, which colour pill does Neo take?",
    "Red",
    ["The red pill", "Red pill"]
  ),
  q(
    "fi-04",
    "film",
    "global",
    2,
    "Which film won the first Academy Award for Best Animated Feature?",
    "Shrek"
  ),
  q(
    "fi-05",
    "film",
    "global",
    3,
    "Who directed Pulp Fiction?",
    "Quentin Tarantino",
    ["Tarantino"]
  ),
  q(
    "fi-06",
    "film",
    "global",
    3,
    "Which actor played the Joker in The Dark Knight?",
    "Heath Ledger",
    ["Ledger"]
  ),
  q(
    "fi-07",
    "film",
    "global",
    4,
    "Which Japanese director made Seven Samurai?",
    "Akira Kurosawa",
    ["Kurosawa"]
  ),
  q(
    "fi-08",
    "film",
    "global",
    5,
    "Which 1927 film is regarded as the first feature-length talkie?",
    "The Jazz Singer",
    ["Jazz Singer"]
  ),
  q(
    "fi-09",
    "film",
    "au",
    2,
    "Which 1986 film starred Paul Hogan as an outback crocodile hunter?",
    "Crocodile Dundee"
  ),
  q(
    "fi-10",
    "film",
    "au",
    3,
    "Which Australian director made the Mad Max films?",
    "George Miller",
    ["Miller"]
  ),
  q(
    "fi-11",
    "film",
    "uk",
    2,
    "Which fictional spy has the code number 007?",
    "James Bond",
    ["Bond"]
  ),
  q(
    "fi-12",
    "film",
    "us",
    3,
    "Which 1941 Orson Welles film opens with the word Rosebud?",
    "Citizen Kane"
  ),
  // Sport
  q(
    "sp-01",
    "sport",
    "global",
    1,
    "How many players does a football (soccer) team have on the pitch?",
    "Eleven",
    ["11"]
  ),
  q(
    "sp-02",
    "sport",
    "global",
    1,
    "In which sport would you perform a slam dunk?",
    "Basketball"
  ),
  q(
    "sp-03",
    "sport",
    "global",
    2,
    "How many rings are on the Olympic flag?",
    "Five",
    ["5"]
  ),
  q(
    "sp-04",
    "sport",
    "global",
    2,
    "In tennis, what is a score of zero called?",
    "Love"
  ),
  q(
    "sp-05",
    "sport",
    "global",
    3,
    "Which country won the first FIFA World Cup, in 1930?",
    "Uruguay"
  ),
  q(
    "sp-06",
    "sport",
    "global",
    3,
    "How long is a marathon, to the nearest kilometre?",
    "42 kilometres",
    ["42", "42 km", "42km"]
  ),
  q(
    "sp-07",
    "sport",
    "global",
    4,
    "Which city hosted the first modern Olympic Games, in 1896?",
    "Athens"
  ),
  q(
    "sp-08",
    "sport",
    "global",
    5,
    "In which year did Roger Bannister run the first sub-four-minute mile?",
    "1954"
  ),
  q(
    "sp-09",
    "sport",
    "au",
    2,
    "On which ground is the AFL Grand Final traditionally played?",
    "Melbourne Cricket Ground",
    ["MCG", "The MCG"]
  ),
  q(
    "sp-10",
    "sport",
    "au",
    3,
    "What was cricketer Don Bradman's Test batting average?",
    "99.94"
  ),
  q(
    "sp-11",
    "sport",
    "uk",
    2,
    "Which tennis tournament is played on grass in London each summer?",
    "Wimbledon"
  ),
  q(
    "sp-12",
    "sport",
    "us",
    2,
    "Which game decides the NFL championship?",
    "The Super Bowl",
    ["Super Bowl", "Superbowl"]
  ),
  // Science
  q(
    "sc-01",
    "science",
    "global",
    1,
    "What is the chemical symbol for water?",
    "H2O"
  ),
  q(
    "sc-02",
    "science",
    "global",
    1,
    "Which planet is known as the Red Planet?",
    "Mars"
  ),
  q(
    "sc-03",
    "science",
    "global",
    2,
    "What gas do plants absorb from the air?",
    "Carbon dioxide",
    ["CO2"]
  ),
  q(
    "sc-04",
    "science",
    "global",
    2,
    "How many bones are in the adult human body?",
    "206"
  ),
  q(
    "sc-05",
    "science",
    "global",
    3,
    "What is the hardest natural substance?",
    "Diamond"
  ),
  q(
    "sc-06",
    "science",
    "global",
    3,
    "Which element has the chemical symbol Au?",
    "Gold"
  ),
  q(
    "sc-07",
    "science",
    "global",
    4,
    "What is the powerhouse of the cell?",
    "Mitochondria",
    ["The mitochondria", "Mitochondrion"]
  ),
  q(
    "sc-08",
    "science",
    "global",
    4,
    "Which scientist proposed the three laws of planetary motion?",
    "Johannes Kepler",
    ["Kepler"]
  ),
  q(
    "sc-09",
    "science",
    "global",
    5,
    "What is the SI unit of electrical capacitance?",
    "Farad",
    ["The farad"]
  ),
  q(
    "sc-10",
    "science",
    "global",
    5,
    "Which particle carries the electromagnetic force?",
    "Photon",
    ["The photon"]
  ),
  q(
    "sc-11",
    "science",
    "au",
    3,
    "Which egg-laying Australian mammal has a duck-like bill?",
    "Platypus",
    ["The platypus"]
  ),
  q(
    "sc-12",
    "science",
    "uk",
    3,
    "Which English naturalist wrote On the Origin of Species?",
    "Charles Darwin",
    ["Darwin"]
  ),
  // History
  q(
    "hi-01",
    "history",
    "global",
    1,
    "Who was the first person to walk on the Moon?",
    "Neil Armstrong",
    ["Armstrong"]
  ),
  q(
    "hi-02",
    "history",
    "global",
    1,
    "In which year did the Second World War end?",
    "1945"
  ),
  q(
    "hi-03",
    "history",
    "global",
    2,
    "Which ancient civilisation built Machu Picchu?",
    "The Inca",
    ["Inca", "Incas", "The Incas"]
  ),
  q(
    "hi-04",
    "history",
    "global",
    2,
    "Which wall fell in 1989, reuniting a European city?",
    "The Berlin Wall",
    ["Berlin Wall"]
  ),
  q(
    "hi-05",
    "history",
    "global",
    3,
    "Who was the first emperor of Rome?",
    "Augustus",
    ["Octavian", "Caesar Augustus"]
  ),
  q(
    "hi-06",
    "history",
    "global",
    3,
    "In which year did the French Revolution begin?",
    "1789"
  ),
  q(
    "hi-07",
    "history",
    "global",
    4,
    "Which treaty ended the First World War with Germany?",
    "The Treaty of Versailles",
    ["Treaty of Versailles", "Versailles"]
  ),
  q(
    "hi-08",
    "history",
    "global",
    5,
    "Which empire did Suleiman the Magnificent rule?",
    "The Ottoman Empire",
    ["Ottoman Empire", "Ottoman", "The Ottomans", "Ottomans"]
  ),
  q(
    "hi-09",
    "history",
    "au",
    2,
    "In which year did Australia become a federation?",
    "1901"
  ),
  q(
    "hi-10",
    "history",
    "au",
    3,
    "Who was Australia's first Prime Minister?",
    "Edmund Barton",
    ["Barton"]
  ),
  q(
    "hi-11",
    "history",
    "uk",
    2,
    "In which year was the Battle of Hastings?",
    "1066"
  ),
  q(
    "hi-12",
    "history",
    "us",
    2,
    "In which year was the US Declaration of Independence signed?",
    "1776"
  ),
  // Geography
  q(
    "ge-01",
    "geography",
    "global",
    1,
    "What is the largest ocean on Earth?",
    "The Pacific Ocean",
    ["Pacific", "Pacific Ocean", "The Pacific"]
  ),
  q(
    "ge-02",
    "geography",
    "global",
    1,
    "Which country is home to the Eiffel Tower?",
    "France"
  ),
  q(
    "ge-03",
    "geography",
    "global",
    2,
    "What is the capital of Japan?",
    "Tokyo"
  ),
  q(
    "ge-04",
    "geography",
    "global",
    2,
    "Which is the longest river in South America?",
    "The Amazon",
    ["Amazon", "Amazon River", "The Amazon River"]
  ),
  q(
    "ge-05",
    "geography",
    "global",
    3,
    "What is the capital of Canada?",
    "Ottawa"
  ),
  q(
    "ge-06",
    "geography",
    "global",
    3,
    "Which desert covers much of northern Africa?",
    "The Sahara",
    ["Sahara", "Sahara Desert", "The Sahara Desert"]
  ),
  q(
    "ge-07",
    "geography",
    "global",
    4,
    "What is the capital of Kazakhstan?",
    "Astana"
  ),
  q(
    "ge-08",
    "geography",
    "global",
    5,
    "Which is the only country crossed by both the Equator and the Tropic of Capricorn?",
    "Brazil"
  ),
  q(
    "ge-09",
    "geography",
    "au",
    2,
    "What is the capital of Australia?",
    "Canberra"
  ),
  q(
    "ge-10",
    "geography",
    "au",
    3,
    "Which is Australia's longest river?",
    "The Murray",
    ["Murray", "Murray River", "The Murray River"]
  ),
  q(
    "ge-11",
    "geography",
    "uk",
    2,
    "Which river runs through London?",
    "The Thames",
    ["Thames", "River Thames", "The River Thames"]
  ),
  q(
    "ge-12",
    "geography",
    "us",
    2,
    "Which is the largest US state by area?",
    "Alaska"
  ),
  ...MORE_QUESTIONS
];

// lib/bank.ts
var store = globalThis;
var histories = store.__triviaBank ??= /* @__PURE__ */ new Map();
function history(owner) {
  let found = histories.get(owner);
  if (!found) {
    found = { week: 0, asked: /* @__PURE__ */ new Map() };
    histories.set(owner, found);
  }
  return found;
}
function dumpBank() {
  return Object.fromEntries(
    [...histories].map(([owner, found]) => [
      owner,
      { week: found.week, asked: [...found.asked.values()] }
    ])
  );
}
function loadBank(dump) {
  histories.clear();
  for (const [owner, found] of Object.entries(dump))
    histories.set(owner, {
      week: found.week,
      asked: new Map(found.asked.map((item) => [item.question_id, item]))
    });
}
function askedRecords(owner) {
  return [...history(owner).asked.values()];
}
function nextWeek(owner) {
  return history(owner).week += 1;
}
function week(owner) {
  return history(owner).week;
}
var ARTICLES = /^(the|a|an)\s+/;
function normalise(answer) {
  return answer.toLowerCase().normalize("NFKD").replace(/[^a-z0-9. ]/g, " ").replace(/\s+/g, " ").trim().replace(ARTICLES, "");
}
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      previous = current;
    }
  }
  return row[b.length];
}
function close(given, accepted) {
  if (accepted.length < 5 || /\d/.test(accepted)) return false;
  return distance(given, accepted) <= (accepted.length >= 10 ? 2 : 1);
}
var WRITTEN_BLANKS = /* @__PURE__ */ new Set([
  "blank",
  "no answer",
  "none",
  "n a",
  "nothing"
]);
function mark(question, answer) {
  const given = normalise(answer);
  if (!given || WRITTEN_BLANKS.has(given)) return "blank";
  if (given === normalise(question.answer)) return "exact";
  const aliases = question.aliases.map(normalise);
  if (aliases.includes(given)) return "alias";
  return [normalise(question.answer), ...aliases].some(
    (accepted) => close(given, accepted)
  ) ? "close" : "wrong";
}
var serve = ({ answer: _answer, aliases: _aliases, ...rest }) => rest;
function nextQuestions(owner, filter, recorder) {
  const mine = history(owner);
  const unseen = QUESTIONS.filter((item) => !mine.asked.has(item.id));
  const region = (item, strict) => !filter.region || item.region === filter.region || !strict && item.region === "global";
  const steps = [
    {
      keep: (item) => (!filter.genre || item.genre === filter.genre) && region(item, true) && (!filter.difficulty || item.difficulty === filter.difficulty)
    },
    {
      relaxed: "region widened to global",
      keep: (item) => (!filter.genre || item.genre === filter.genre) && region(item, false) && (!filter.difficulty || item.difficulty === filter.difficulty)
    },
    {
      relaxed: "difficulty widened by one step",
      keep: (item) => (!filter.genre || item.genre === filter.genre) && region(item, false) && (!filter.difficulty || Math.abs(item.difficulty - filter.difficulty) <= 1)
    },
    {
      relaxed: "any difficulty",
      keep: (item) => (!filter.genre || item.genre === filter.genre) && region(item, false)
    },
    { relaxed: "any genre", keep: (item) => region(item, false) }
  ];
  const chosen = [];
  const relaxed = [];
  for (const step of steps) {
    if (chosen.length >= filter.count) break;
    const more = unseen.filter(
      (item) => step.keep(item) && !chosen.includes(item)
    );
    if (more.length && step.relaxed) relaxed.push(step.relaxed);
    chosen.push(...more.slice(0, filter.count - chosen.length));
  }
  for (const item of chosen)
    mine.asked.set(item.id, {
      question_id: item.id,
      week: mine.week,
      genre: item.genre,
      difficulty: item.difficulty,
      answers: 0,
      correct: 0,
      blanks: 0
    });
  recorder?.(
    owner,
    "bank.served",
    `Served ${chosen.length} unseen question${chosen.length === 1 ? "" : "s"} (${mine.asked.size - chosen.length} already asked here were excluded)`,
    { filter, ids: chosen.map((item) => item.id) }
  );
  if (relaxed.length)
    recorder?.(owner, "bank.relaxed", `Filter ran dry: ${relaxed.join(", ")}`, {
      filter,
      relaxed
    });
  return { questions: chosen.map(serve), relaxed };
}
function recordAnswer(owner, questionId, answer, recorder) {
  const asked = history(owner).asked.get(questionId);
  const question = QUESTIONS.find((item) => item.id === questionId);
  if (!asked || !question)
    throw new Error(`question ${questionId} was not served to this owner`);
  const method = mark(question, answer);
  const correct = method !== "wrong" && method !== "blank";
  asked.answers += 1;
  if (correct) asked.correct += 1;
  if (method === "blank") asked.blanks += 1;
  recorder?.(
    owner,
    "bank.marked",
    `${questionId}: "${answer}" marked ${correct ? "right" : "wrong"} (${method})`,
    { question_id: questionId, answer, method }
  );
  return {
    question_id: questionId,
    correct,
    method,
    accepted_answer: question.answer
  };
}
function summary(owner, ofWeek) {
  const mine = history(owner);
  const target = ofWeek ?? mine.week;
  const tally = () => ({ answers: 0, correct: 0, blanks: 0, rate: 0 });
  const result = {
    week: target,
    asked_total: mine.asked.size,
    by_genre: {},
    by_difficulty: {},
    overall: tally()
  };
  for (const asked of mine.asked.values()) {
    if (asked.week !== target) continue;
    const groups = [
      result.by_genre[asked.genre] ??= tally(),
      result.by_difficulty[asked.difficulty] ??= tally(),
      result.overall
    ];
    for (const group of groups) {
      group.answers += asked.answers;
      group.correct += asked.correct;
      group.blanks += asked.blanks;
      group.rate = group.answers ? group.correct / group.answers : 0;
    }
  }
  return result;
}
function servedIn(owner, questionId, ofWeek) {
  return history(owner).asked.get(questionId)?.week === ofWeek;
}

// lib/events.ts
var MAX_EVENTS = 400;
var store2 = globalThis;
var log = store2.__triviaEvents ??= { seq: 0, events: [] };
var record = (owner, type, summary2, data = {}) => {
  log.seq += 1;
  log.events.push({
    seq: log.seq,
    at: (/* @__PURE__ */ new Date()).toISOString(),
    owner,
    type,
    summary: summary2,
    data
  });
  if (log.events.length > MAX_EVENTS)
    log.events.splice(0, log.events.length - MAX_EVENTS);
};

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var strictDecoder = new TextDecoder("utf-8", { fatal: true });
var UINT32_RANGE = 2 ** 32;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0), buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers)
    buf.set(buffer, i), i += buffer.length;
  return buf;
}
var NON_ASCII = /[^\x00-\x7f]/;
function encode(string) {
  if (typeof string == "string" && string.length >= 128) {
    if (NON_ASCII.test(string))
      throw new TypeError("non-ASCII string encountered in encode()");
    return encoder.encode(string);
  }
  const bytes = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);
    if (code > 127)
      throw new TypeError("non-ASCII string encountered in encode()");
    bytes[i] = code;
  }
  return bytes;
}
function decodeBase64(encoded, url = false) {
  if (Uint8Array.fromBase64)
    return Uint8Array.fromBase64(encoded, { alphabet: url ? "base64url" : "base64" });
  if (url) {
    if (encoded.includes("+") || encoded.includes("/"))
      throw new TypeError("Invalid base64url");
    encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  }
  const binary = atob(encoded), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/util/errors.js
var JOSEError = class extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message2, options) {
    super(message2, options), this.name = this.constructor.name, Error.captureStackTrace?.(this, this.constructor);
  }
};
var JWTClaimValidationFailed = class extends JOSEError {
  static code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } }), this.claim = claim, this.reason = reason, this.payload = payload;
  }
};
var JWTExpired = class extends JOSEError {
  static code = "ERR_JWT_EXPIRED";
  code = "ERR_JWT_EXPIRED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } }), this.claim = claim, this.reason = reason, this.payload = payload;
  }
};
var JOSEAlgNotAllowed = class extends JOSEError {
  static code = "ERR_JOSE_ALG_NOT_ALLOWED";
  code = "ERR_JOSE_ALG_NOT_ALLOWED";
};
var JOSENotSupported = class extends JOSEError {
  static code = "ERR_JOSE_NOT_SUPPORTED";
  code = "ERR_JOSE_NOT_SUPPORTED";
};
var JWSInvalid = class extends JOSEError {
  static code = "ERR_JWS_INVALID";
  code = "ERR_JWS_INVALID";
};
var JWTInvalid = class extends JOSEError {
  static code = "ERR_JWT_INVALID";
  code = "ERR_JWT_INVALID";
};
var JWKSInvalid = class extends JOSEError {
  static code = "ERR_JWKS_INVALID";
  code = "ERR_JWKS_INVALID";
};
var JWKSNoMatchingKey = class extends JOSEError {
  static code = "ERR_JWKS_NO_MATCHING_KEY";
  code = "ERR_JWKS_NO_MATCHING_KEY";
  constructor(message2 = "no applicable key found in the JSON Web Key Set", options) {
    super(message2, options);
  }
};
var JWKSMultipleMatchingKeys = class extends JOSEError {
  [Symbol.asyncIterator] = async function* () {
  };
  static code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  constructor(message2 = "multiple matching keys found in the JSON Web Key Set", options) {
    super(message2, options);
  }
};
var JWKSTimeout = class extends JOSEError {
  static code = "ERR_JWKS_TIMEOUT";
  code = "ERR_JWKS_TIMEOUT";
  constructor(message2 = "request timed out", options) {
    super(message2, options);
  }
};
var JWSSignatureVerificationFailed = class extends JOSEError {
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message2 = "signature verification failed", options) {
    super(message2, options);
  }
};

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/util/base64url.js
var invalid = "The input to be decoded is not correctly encoded.";
function decode(input) {
  try {
    return decodeBase64(typeof input == "string" ? input : decoder.decode(input), true);
  } catch (cause) {
    throw new TypeError(invalid, { cause });
  }
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/lib/validate.js
function isObject(input) {
  if (typeof input != "object" || input === null || Object.prototype.toString.call(input) !== "[object Object]")
    return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
function isJwkSet(input) {
  return isObject(input) && Array.isArray(input.keys) && Array.from(input.keys).every(isObject);
}
function isDisjoint(...headers) {
  const parameters = /* @__PURE__ */ new Set();
  for (const header of headers)
    if (header)
      for (const parameter of Object.keys(header)) {
        if (parameters.has(parameter))
          return false;
        parameters.add(parameter);
      }
  return true;
}
function decodeBase64url(value, label, ErrorClass) {
  try {
    return decode(value);
  } catch (cause) {
    throw new ErrorClass(`Failed to base64url decode the ${label}`, { cause });
  }
}
function encodeAsciiMember(value, label, ErrorClass) {
  try {
    return encode(value);
  } catch (cause) {
    throw new ErrorClass(`The ${label} is not a valid base64url string`, { cause });
  }
}
function parseJoseHeader(encodedProtectedHeader, ErrorClass, message2) {
  let parsed;
  try {
    parsed = JSON.parse(strictDecoder.decode(decode(encodedProtectedHeader)));
  } catch (cause) {
    throw new ErrorClass(message2, { cause });
  }
  if (!isObject(parsed))
    throw new ErrorClass(message2);
  return parsed;
}
var JWS_RECOGNIZED = { __proto__: null, b64: true };
function validateAlgorithms(option, algorithms) {
  if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s != "string")))
    throw new TypeError(`"${option}" option must be an array of strings`);
  return algorithms === void 0 ? void 0 : new Set(algorithms);
}
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0)
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  if (!protectedHeader || protectedHeader.crit === void 0)
    return [];
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input != "string" || input.length === 0))
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  const recognized = recognizedOption === void 0 ? recognizedDefault : { __proto__: null, ...recognizedOption, ...recognizedDefault };
  for (const parameter of protectedHeader.crit) {
    if (!(parameter in recognized))
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    if (!Object.hasOwn(joseHeader, parameter) || joseHeader[parameter] === void 0)
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    if (recognized[parameter] && (!Object.hasOwn(protectedHeader, parameter) || protectedHeader[parameter] === void 0))
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
  }
  return protectedHeader.crit;
}
function validateB64(protectedHeader, extensions) {
  if (extensions.includes("b64")) {
    const b64 = protectedHeader.b64;
    if (typeof b64 != "boolean")
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    return b64;
  }
  return true;
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/lib/key.js
var tag = (key) => key[Symbol.toStringTag];
var jwkMatchesOp = (entry, key, usage) => {
  const { alg } = entry;
  if (key.use !== void 0) {
    const expected = usage === "sign" || usage === "verify" ? "sig" : "enc";
    if (key.use !== expected)
      throw new TypeError(`Invalid key for this operation, its "use" must be "${expected}" when present`);
  }
  if (key.kty === "AKP" && key.alg === void 0)
    throw new TypeError('missing "alg" (Algorithm) Parameter value');
  if (key.alg !== void 0 && key.alg !== alg)
    throw new TypeError(`Invalid key for this operation, its "alg" must be "${alg}" when present`);
  if (Array.isArray(key.key_ops)) {
    const expectedKeyOp = usage === "encrypt" || usage === "decrypt" ? entry.ops?.[usage === "encrypt" ? 0 : 1] : usage;
    if (expectedKeyOp && !key.key_ops.includes(expectedKeyOp))
      throw new TypeError(`Invalid key for this operation, its "key_ops" must include "${expectedKeyOp}" when present`);
  }
};
async function prepareKey(entry, key, usage) {
  const { alg, secret } = entry, requiresPrivateKey = usage === "decrypt" || usage === "sign";
  if (secret && key instanceof Uint8Array)
    return key;
  let normalized, keyObject;
  if (isObject(key)) {
    if (normalized = normalizeJwk(key), typeof normalized.kty != "string")
      throw invalidKeyType(alg, key, secret);
    if (!(secret ? normalized.kty === "oct" && typeof normalized.k == "string" : normalized.kty !== "oct" && (requiresPrivateKey ? normalized.kty === "AKP" && typeof normalized.priv == "string" || typeof normalized.d == "string" : normalized.d === void 0 && normalized.priv === void 0)))
      throw new TypeError(secret ? 'JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present' : `JSON Web Key for this operation must be a ${requiresPrivateKey ? "private" : "public"} JWK`);
    if (jwkMatchesOp(entry, normalized, usage), normalized.kty === "oct")
      return decode(normalized.k);
    if (!Object.isFrozen(key)) {
      const { key_ops } = key;
      Array.isArray(key_ops) && Object.freeze(key_ops), Object.freeze(key);
    }
  } else {
    if (!isKeyLike(key))
      throw invalidKeyType(alg, key, secret);
    const expectedType = secret ? "secret" : requiresPrivateKey ? "private" : "public";
    if (key.type !== expectedType && (secret || ["secret", "public", "private"].includes(key.type)))
      throw new TypeError(`${tag(key)} instances must be of type "${expectedType}" for the ${alg} algorithm`);
    if (isCryptoKey(key))
      return key;
    if (keyObject = key, keyObject.type === "secret")
      return keyObject.export();
  }
  cache ||= /* @__PURE__ */ new WeakMap();
  const cacheKey = key;
  let cached = cache.get(cacheKey);
  if (cached?.[alg])
    return cached[alg];
  if (cached || cache.set(cacheKey, cached = {}), keyObject && typeof keyObject.toCryptoKey == "function") {
    const isPublic = keyObject.type === "public", crv = nist[keyObject.asymmetricKeyDetails?.namedCurve], params = entry.resolve?.({ crv, asymmetricKeyType: keyObject.asymmetricKeyType }) ?? entry.subtle;
    return cached[alg] = keyObject.toCryptoKey(params, isPublic, entry.usages[isPublic ? 0 : 1]);
  }
  return normalized ??= keyObject.export({ format: "jwk" }), normalized.alg = alg, cached[alg] = await jwkToKey(entry, normalized);
}
var cache;
var nist = {
  __proto__: null,
  prime256v1: "P-256",
  secp384r1: "P-384",
  secp521r1: "P-521"
};
var isCryptoKey = (key) => {
  if (key?.[Symbol.toStringTag] === "CryptoKey")
    return true;
  try {
    return key instanceof CryptoKey;
  } catch {
    return false;
  }
};
var isKeyObject = (key) => key?.[Symbol.toStringTag] === "KeyObject";
var isKeyLike = (key) => isCryptoKey(key) || isKeyObject(key);
function message(msg, actual, ...types) {
  if (types.length > 2) {
    const last = types.pop();
    msg += `one of type ${types.join(", ")}, or ${last}.`;
  } else types.length === 2 ? msg += `one of type ${types[0]} or ${types[1]}.` : msg += `of type ${types[0]}.`;
  return actual == null ? msg += ` Received ${actual}` : typeof actual == "function" && actual.name ? msg += ` Received function ${actual.name}` : typeof actual == "object" && actual != null && actual.constructor?.name && (msg += ` Received an instance of ${actual.constructor.name}`), msg;
}
function invalidKeyType(alg, actual, secret) {
  const types = ["CryptoKey", "KeyObject", "JSON Web Key"];
  return secret && types.push("Uint8Array"), new TypeError(message(`Key for the ${alg} algorithm must be `, actual, ...types));
}
var unusable = (name, prop = "algorithm.name") => new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
function checkUsage(key, usage) {
  if (usage && !key.usages.includes(usage))
    throw new TypeError(`CryptoKey does not support this operation, its usages must include ${usage}.`);
}
function checkModulusLength(alg, key) {
  const { modulusLength } = key.algorithm;
  if (typeof modulusLength != "number" || modulusLength < 2048)
    throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
}
function checkCryptoKey(key, expected, usage) {
  const algorithm = key.algorithm;
  if (algorithm.name !== expected.name)
    throw unusable(expected.name);
  if (expected.hash && algorithm.hash?.name !== expected.hash)
    throw unusable(expected.hash, "algorithm.hash");
  if (expected.namedCurve && algorithm.namedCurve !== expected.namedCurve)
    throw unusable(expected.namedCurve, "algorithm.namedCurve");
  if (expected.length !== void 0 && algorithm.length !== expected.length)
    throw unusable(expected.length, "algorithm.length");
  checkUsage(key, usage);
}
function snapshotJwk(jwk) {
  return { __proto__: null, ...jwk };
}
function normalizeJwk(jwk) {
  const normalized = snapshotJwk(jwk);
  if (normalized.ext !== void 0 && typeof normalized.ext != "boolean")
    throw new TypeError('"ext" (Extractable) Parameter must be a boolean');
  if (normalized.key_ops !== void 0) {
    const value = normalized.key_ops, keyOps = Array.isArray(value) ? [...value] : void 0;
    if (!keyOps || keyOps.some((operation) => typeof operation != "string") || new Set(keyOps).size !== keyOps.length)
      throw new TypeError('"key_ops" (Key Operations) Parameter must be an array of unique strings');
    normalized.key_ops = keyOps;
  }
  return normalized;
}
async function jwkToKey(entry, jwk, extractable) {
  if (!entry.kty.includes(jwk.kty))
    throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
  const algorithm = entry.resolve?.({ kty: jwk.kty, crv: jwk.crv }) ?? entry.subtle, isPrivate = !!(jwk.d || jwk.priv), keyData = { ...jwk, ext: extractable ?? jwk.ext };
  return keyData.kty !== "AKP" && delete keyData.alg, delete keyData.use, crypto.subtle.importKey("jwk", keyData, algorithm, keyData.ext ?? !isPrivate, jwk.key_ops ?? entry.usages[isPrivate ? 1 : 0]);
}
async function rawKey(key, expected, usage, extractable = false) {
  return key instanceof Uint8Array && (key = await crypto.subtle.importKey("raw", key, expected, extractable, [usage])), checkCryptoKey(key, expected, usage), key;
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/lib/key_descriptor.js
function table(entries) {
  const out = { __proto__: null };
  for (const alg in entries)
    out[alg] = { ...entries[alg], alg };
  return out;
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/lib/jws_algorithms.js
var sig = [["verify"], ["sign"]];
function hmac(bits) {
  const subtle = { name: "HMAC", hash: `SHA-${bits}` };
  return { kty: ["oct"], secret: true, subtle, signing: subtle, usages: sig };
}
function rsa(bits, saltLength) {
  const subtle = { name: saltLength ? "RSA-PSS" : "RSASSA-PKCS1-v1_5", hash: `SHA-${bits}` };
  return {
    kty: ["RSA"],
    subtle,
    signing: saltLength ? { ...subtle, saltLength } : subtle,
    usages: sig,
    minRsaBits: 2048
  };
}
function ecdsa(crv, bits) {
  return {
    kty: ["EC"],
    crv,
    subtle: { name: "ECDSA", namedCurve: crv },
    signing: { name: "ECDSA", hash: `SHA-${bits}` },
    usages: sig
  };
}
function eddsa() {
  const subtle = { name: "Ed25519" };
  return {
    kty: ["OKP"],
    crv: "Ed25519",
    subtle,
    signing: subtle,
    usages: sig
  };
}
function mldsa(parameterSet) {
  const subtle = { name: `ML-DSA-${parameterSet}` };
  return {
    kty: ["AKP"],
    subtle,
    signing: subtle,
    usages: sig
  };
}
var JWS = table({
  HS256: hmac(256),
  HS384: hmac(384),
  HS512: hmac(512),
  RS256: rsa(256),
  RS384: rsa(384),
  RS512: rsa(512),
  PS256: rsa(256, 32),
  PS384: rsa(384, 48),
  PS512: rsa(512, 64),
  ES256: ecdsa("P-256", 256),
  ES384: ecdsa("P-384", 384),
  ES512: ecdsa("P-521", 512),
  EdDSA: eddsa(),
  Ed25519: eddsa(),
  "ML-DSA-44": mldsa(44),
  "ML-DSA-65": mldsa(65),
  "ML-DSA-87": mldsa(87)
});
function jwsAlgorithm(alg) {
  const entry = typeof alg == "string" ? JWS[alg] : void 0;
  if (!entry)
    throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  return entry;
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/lib/jws_verify.js
function prepareVerify(options) {
  return [options && validateAlgorithms("algorithms", options.algorithms), options?.crit];
}
function parseProtectedHeader(encodedProtectedHeader) {
  return encodedProtectedHeader === void 0 ? {} : parseJoseHeader(encodedProtectedHeader, JWSInvalid, "JWS Protected Header is invalid");
}
function encodeCompactUnencodedPayload(payload) {
  try {
    return encode(payload);
  } catch (cause) {
    throw new JWSInvalid("JWS Compact Serialization payload must use only ASCII characters", {
      cause
    });
  }
}
async function verifySignature(jws, shared, key, encodeUnencodedPayload, parsedProtected) {
  const { protected: encodedProtectedHeader, header, payload: inputPayload } = jws, protectedHeader = parsedProtected ?? parseProtectedHeader(encodedProtectedHeader);
  if (!isDisjoint(protectedHeader, header))
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  const joseHeader = { ...protectedHeader, ...header }, b64 = validateB64(protectedHeader, validateCrit(JWSInvalid, JWS_RECOGNIZED, shared[1], protectedHeader, joseHeader)), { alg } = joseHeader;
  if (typeof alg != "string" || !alg)
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  if (shared[0] && !shared[0].has(alg))
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  if (b64) {
    if (typeof inputPayload != "string")
      throw new JWSInvalid("JWS Payload must be a string");
  } else if (typeof inputPayload != "string" && !(inputPayload instanceof Uint8Array))
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  const signingPayload = b64 || typeof inputPayload != "string" ? inputPayload : encodeUnencodedPayload(inputPayload);
  let resolvedKey = false;
  typeof key == "function" && (key = await key(protectedHeader, jws), resolvedKey = true);
  const entry = jwsAlgorithm(alg), signingInput = concat(encodedProtectedHeader !== void 0 ? encode(encodedProtectedHeader) : new Uint8Array(), encode("."), typeof signingPayload == "string" ? shared[2] ??= encodeAsciiMember(signingPayload, "payload", JWSInvalid) : signingPayload), signature = decodeBase64url(jws.signature, "signature", JWSInvalid), verificationKey = await prepareKey(entry, key, "verify"), cryptoKey = await rawKey(verificationKey, entry.subtle, "verify");
  entry.minRsaBits && checkModulusLength(entry.alg, cryptoKey);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(entry.signing, cryptoKey, signature, signingInput);
  } catch (cause) {
    throw new JWSSignatureVerificationFailed(void 0, { cause });
  }
  if (!verified)
    throw new JWSSignatureVerificationFailed();
  const result = { payload: typeof signingPayload == "string" ? decodeBase64url(signingPayload, "payload", JWSInvalid) : signingPayload };
  return encodedProtectedHeader !== void 0 && (result.protectedHeader = protectedHeader), header !== void 0 && (result.unprotectedHeader = header), resolvedKey ? [{ ...result, key: verificationKey }, b64] : [result, b64];
}
async function verifyCompact(jws, shared, key) {
  if (jws instanceof Uint8Array && (jws = decoder.decode(jws)), typeof jws != "string")
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3)
    throw new JWSInvalid("Invalid Compact JWS");
  return verifySignature({ payload, protected: protectedHeader, signature }, shared, key, encodeCompactUnencodedPayload);
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/lib/jwt_claims_set.js
var epoch = (date) => Math.floor(date.getTime() / 1e3);
var multipliers = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31557600
};
var REGEX = /^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$/i;
var checkFailed = "check_failed";
function invalidDuration() {
  throw new TypeError("Invalid time period format");
}
function secs(str) {
  typeof str != "string" && invalidDuration();
  const matched = REGEX.exec(str);
  (!matched || matched[4] && matched[1]) && invalidDuration();
  const value = parseFloat(matched[2]), durationSeconds = Math.round(value * multipliers[matched[3][0].toLowerCase()]);
  return Number.isFinite(durationSeconds) || invalidDuration(), matched[1] === "-" || matched[4]?.toLowerCase() === "ago" ? -durationSeconds : durationSeconds;
}
function validateInput(label, input) {
  if (!Number.isFinite(input))
    throw new TypeError(`Invalid ${label} input`);
  return input;
}
var normalizeTyp = (value) => {
  const normalized = value.toLowerCase();
  return value.includes("/") ? normalized : `application/${normalized}`;
};
var checkAudiencePresence = (audPayload, audOption) => typeof audPayload == "string" ? audOption.includes(audPayload) : Array.isArray(audPayload) ? audOption.some((aud) => audPayload.includes(aud)) : false;
function validateNumericDate(claimsSet, claim, required = false) {
  const value = claimsSet[claim];
  if (!(value === void 0 && !required)) {
    if (typeof value != "number")
      throw new JWTClaimValidationFailed(`"${claim}" claim must be a number`, claimsSet, claim, "invalid");
    return value;
  }
}
function unexpectedClaim(claimsSet, claim) {
  throw new JWTClaimValidationFailed(`unexpected "${claim}" claim value`, claimsSet, claim, checkFailed);
}
function validateClaimsSet(protectedHeader, claimsSetBytes, options = {}) {
  let claimsSet;
  try {
    claimsSet = JSON.parse(strictDecoder.decode(claimsSetBytes));
  } catch (cause) {
    throw new JWTInvalid("JWT Claims Set must be a top-level JSON object", { cause });
  }
  if (!isObject(claimsSet))
    throw new JWTInvalid("JWT Claims Set must be a top-level JSON object");
  const { typ } = options;
  if (typ !== void 0 && (typeof protectedHeader.typ != "string" || normalizeTyp(protectedHeader.typ) !== normalizeTyp(typ)))
    throw new JWTClaimValidationFailed('unexpected "typ" JWT header value', claimsSet, "typ", checkFailed);
  const { requiredClaims = [], issuer, subject, audience, maxTokenAge } = options, presenceCheck = [...requiredClaims];
  maxTokenAge !== void 0 && presenceCheck.push("iat"), audience !== void 0 && presenceCheck.push("aud"), subject !== void 0 && presenceCheck.push("sub"), issuer !== void 0 && presenceCheck.push("iss");
  for (const claim of new Set(presenceCheck.reverse()))
    if (!Object.hasOwn(claimsSet, claim))
      throw new JWTClaimValidationFailed(`missing required "${claim}" claim`, claimsSet, claim, "missing");
  issuer !== void 0 && !(Array.isArray(issuer) ? issuer : [issuer]).includes(claimsSet.iss) && unexpectedClaim(claimsSet, "iss"), subject !== void 0 && claimsSet.sub !== subject && unexpectedClaim(claimsSet, "sub"), audience !== void 0 && !checkAudiencePresence(claimsSet.aud, typeof audience == "string" ? [audience] : audience) && unexpectedClaim(claimsSet, "aud");
  const { clockTolerance } = options;
  let tolerance = 0;
  if (typeof clockTolerance == "string")
    tolerance = secs(clockTolerance);
  else if (clockTolerance !== void 0) {
    if (typeof clockTolerance != "number")
      throw new TypeError("Invalid clockTolerance option type");
    tolerance = clockTolerance;
  }
  if (validateInput("clockTolerance option", tolerance), tolerance < 0)
    throw new TypeError("Invalid clockTolerance option input");
  const { currentDate } = options, now = validateInput("currentDate option", epoch(currentDate === void 0 ? /* @__PURE__ */ new Date() : currentDate)), iat = validateNumericDate(claimsSet, "iat", maxTokenAge !== void 0), nbf = validateNumericDate(claimsSet, "nbf");
  if (nbf !== void 0 && nbf > now + tolerance)
    throw new JWTClaimValidationFailed('"nbf" claim timestamp check failed', claimsSet, "nbf", checkFailed);
  const exp = validateNumericDate(claimsSet, "exp");
  if (exp !== void 0 && exp <= now - tolerance)
    throw new JWTExpired('"exp" claim timestamp check failed', claimsSet, "exp", checkFailed);
  if (maxTokenAge !== void 0) {
    const age = now - iat, max = validateInput("maxTokenAge option", typeof maxTokenAge == "number" ? maxTokenAge : secs(maxTokenAge));
    if (max < 0)
      throw new TypeError("Invalid maxTokenAge option input");
    if (age - tolerance > max)
      throw new JWTExpired('"iat" claim timestamp check failed (too far in the past)', claimsSet, "iat", checkFailed);
    if (age < -tolerance)
      throw new JWTClaimValidationFailed('"iat" claim timestamp check failed (it should be in the past)', claimsSet, "iat", checkFailed);
  }
  return claimsSet;
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/jwt/verify.js
async function jwtVerify(jwt, key, options) {
  const [verified, b64] = await verifyCompact(jwt, prepareVerify(options), key);
  if (!b64)
    throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
  const payload = validateClaimsSet(verified.protectedHeader, verified.payload, options);
  return { ...verified, payload };
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/jwks/local.js
function isUsableJWK(jwk, entry, alg, kid) {
  const { kty, key_ops: keyOps, ext, kid: jwkKid, alg: jwkAlg, use, crv } = jwk;
  return (ext === void 0 || typeof ext == "boolean") && (keyOps === void 0 || Array.isArray(keyOps) && keyOps.every((operation, index) => typeof operation == "string" && keyOps.indexOf(operation) === index) && keyOps.includes("verify")) && entry.kty.includes(kty) && (kid === void 0 || typeof kid == "string" && kid === jwkKid) && (jwkAlg === void 0 ? kty !== "AKP" : alg === jwkAlg) && (use === void 0 || use === "sig") && (!entry.crv || crv === entry.crv);
}
async function importWithAlgCache(cache2, jwk, entry) {
  const cached = cache2.get(jwk) || cache2.set(jwk, {}).get(jwk), { alg } = entry;
  if (cached[alg] === void 0) {
    const pending = jwkToKey(entry, jwk, true).then((key) => {
      if (key.type !== "public")
        throw new JWKSInvalid("JSON Web Key Set members must be public keys");
      return cached[alg] = key, key;
    }).catch((error) => {
      throw cached[alg] === pending && delete cached[alg], error;
    });
    cached[alg] = pending;
  }
  return cached[alg];
}
function createLocalJWKSet(jwks) {
  let snapshot;
  try {
    snapshot = structuredClone(jwks);
  } catch (cause) {
    throw new JWKSInvalid("JSON Web Key Set malformed", { cause });
  }
  if (!isJwkSet(snapshot))
    throw new JWKSInvalid("JSON Web Key Set malformed");
  const metadata = snapshot.keys.map((jwk) => {
    const normalized = snapshotJwk(jwk);
    return Array.isArray(normalized.key_ops) && (normalized.key_ops = [...normalized.key_ops]), normalized;
  }), cached = /* @__PURE__ */ new WeakMap();
  return Object.defineProperty(async (protectedHeader, token) => {
    const { alg, kid } = { ...protectedHeader, ...token?.header }, entry = typeof alg == "string" ? JWS[alg] : void 0;
    if (!entry || entry.secret)
      throw new JOSENotSupported('Unsupported "alg" value for a JSON Web Key Set');
    const candidates = snapshot.keys.filter((_, index) => isUsableJWK(metadata[index], entry, alg, kid)), { 0: jwk, length } = candidates;
    if (!length)
      throw new JWKSNoMatchingKey();
    if (length !== 1) {
      const error = new JWKSMultipleMatchingKeys();
      throw error[Symbol.asyncIterator] = async function* () {
        for (const jwk2 of candidates)
          try {
            yield await importWithAlgCache(cached, jwk2, entry);
          } catch {
          }
      }, error;
    }
    return importWithAlgCache(cached, jwk, entry);
  }, "jwks", {
    value: () => structuredClone(snapshot)
  });
}

// ../../node_modules/.pnpm/jose@6.2.18/node_modules/jose/dist/webapi/jwks/remote.js
function isCloudflareWorkers() {
  return typeof WebSocketPair < "u" || typeof navigator < "u" && navigator.userAgent === "Cloudflare-Workers" || typeof EdgeRuntime < "u" && EdgeRuntime === "vercel";
}
var USER_AGENT;
(typeof navigator > "u" || !navigator.userAgent?.startsWith?.("Mozilla/5.0 ")) && (USER_AGENT = "jose/v6.2.18");
var customFetch = /* @__PURE__ */ Symbol();
async function fetchJwks(url, headers, signal, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "GET",
    signal,
    redirect: "manual",
    headers
  }).catch((err) => {
    throw err.name === "TimeoutError" ? new JWKSTimeout(void 0, { cause: err }) : err;
  });
  if (response.status !== 200)
    throw new JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response");
  try {
    return await response.json();
  } catch (cause) {
    throw signal.aborted ? new JWKSTimeout(void 0, { cause }) : new JOSEError("Failed to parse the JSON Web Key Set HTTP response as JSON", { cause });
  }
}
var jwksCache = /* @__PURE__ */ Symbol();
function isFreshFor(timestamp, duration) {
  return Number.isFinite(timestamp) && Date.now() < timestamp + duration;
}
function validateDuration(value, fallback, option) {
  if (Number.isNaN(value))
    throw new TypeError(`"${option}" option must not be NaN`);
  if (typeof value == "number" && value < 0)
    throw new TypeError(`"${option}" option must not be negative`);
  return typeof value == "number" ? value : fallback;
}
function createRemoteJWKSet(url, options) {
  if (!(url instanceof URL))
    throw new TypeError("url must be an instance of URL");
  const href = new URL(url.href).href, opts = options ?? {}, timeoutOption = opts.timeoutDuration;
  if (typeof timeoutOption == "number" && (!Number.isInteger(timeoutOption) || timeoutOption < 0))
    throw new TypeError('"timeoutDuration" option must be a non-negative integer');
  const timeoutDuration = typeof timeoutOption == "number" ? timeoutOption : 5e3, cooldownDuration = validateDuration(opts.cooldownDuration, 3e4, "cooldownDuration"), cacheMaxAge = validateDuration(opts.cacheMaxAge, 6e5, "cacheMaxAge"), headers = new Headers(opts.headers);
  USER_AGENT && !headers.has("User-Agent") && headers.set("User-Agent", USER_AGENT), headers.has("accept") || headers.set("accept", "application/json, application/jwk-set+json");
  const fetchImpl = opts[customFetch], cache2 = opts[jwksCache];
  let jwksTimestamp, pendingFetch, reloadSequence = 0, appliedSequence = 0, local;
  if (cache2 && typeof cache2 == "object") {
    const { uat, jwks } = cache2;
    isFreshFor(uat, cacheMaxAge) && isJwkSet(jwks) && (jwksTimestamp = uat, local = createLocalJWKSet(jwks));
  }
  const reload = async () => {
    if (pendingFetch && isCloudflareWorkers() && (pendingFetch = void 0), !pendingFetch) {
      const sequence = ++reloadSequence, current = pendingFetch = fetchJwks(href, headers, AbortSignal.timeout(timeoutDuration), fetchImpl).then((json) => {
        const next = createLocalJWKSet(json);
        if (sequence <= appliedSequence)
          return;
        local = next;
        const updatedAt = Date.now();
        cache2 && (cache2.uat = updatedAt, cache2.jwks = json), jwksTimestamp = updatedAt, appliedSequence = sequence;
      }).finally(() => {
        pendingFetch === current && (pendingFetch = void 0);
      });
    }
    await pendingFetch;
  };
  return Object.defineProperties(async (protectedHeader, token) => {
    (!local || !isFreshFor(jwksTimestamp, cacheMaxAge)) && await reload();
    try {
      return await local(protectedHeader, token);
    } catch (err) {
      if (err instanceof JWKSNoMatchingKey && !isFreshFor(jwksTimestamp, cooldownDuration))
        return await reload(), local(protectedHeader, token);
      throw err;
    }
  }, {
    coolingDown: {
      get: () => isFreshFor(jwksTimestamp, cooldownDuration),
      enumerable: true
    },
    fresh: {
      get: () => isFreshFor(jwksTimestamp, cacheMaxAge),
      enumerable: true
    },
    reload: {
      value: reload,
      enumerable: true
    },
    reloading: {
      get: () => !!pendingFetch,
      enumerable: true
    },
    jwks: {
      value: () => local?.jwks(),
      enumerable: true
    }
  });
}

// lib/identity.ts
var ISSUER = process.env.TRIVIA_ISSUER;
var AUDIENCE = process.env.TRIVIA_AUDIENCE;
var ACCEPT_ATTRIBUTION = process.env.TRIVIA_ACCEPT_ATTRIBUTION === "1";
var DEV_OWNER_HEADER = process.env.TRIVIA_DEV_OWNER_HEADER === "1";
var DEV_OWNER = process.env.TRIVIA_DEV_OWNER;
var keys = ISSUER ? createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`)) : void 0;
var Unidentified = class extends Error {
};
async function ownerOf(request) {
  const bearer = /^Bearer\s+(.+)$/i.exec(
    request.headers.get("authorization") ?? ""
  )?.[1];
  if (keys && bearer) {
    const { payload } = await jwtVerify(bearer, keys, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["ES256"]
    }).catch((error) => {
      throw new Unidentified(
        `the end-user token did not verify: ${error.message}`
      );
    });
    const accepted = payload.type === "identity_assertion" || ACCEPT_ATTRIBUTION && payload.type === "identity_attribution";
    if (!accepted || !payload.sub)
      throw new Unidentified(`a ${String(payload.type)} token is not accepted`);
    return payload.sub;
  }
  const header = request.headers.get("x-trivia-owner");
  if (DEV_OWNER_HEADER && header) return header;
  if (DEV_OWNER) return DEV_OWNER;
  throw new Unidentified("no end user: the call carried no accepted token");
}

// lib/state.ts
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// lib/scorer.ts
var store3 = globalThis;
var all = store3.__triviaScores ??= /* @__PURE__ */ new Map();
function scores(owner) {
  let found = all.get(owner);
  if (!found) {
    found = {
      season: /* @__PURE__ */ new Map(),
      tonight: { week: 0, teams: [], points: /* @__PURE__ */ new Map() },
      answered: /* @__PURE__ */ new Set(),
      rounds: []
    };
    all.set(owner, found);
  }
  return found;
}
function dumpScores() {
  return Object.fromEntries(
    [...all].map(([owner, found]) => [
      owner,
      {
        season: [...found.season],
        tonight: { ...found.tonight, points: [...found.tonight.points] },
        answered: [...found.answered],
        rounds: found.rounds
      }
    ])
  );
}
function loadScores(dump) {
  all.clear();
  for (const [owner, found] of Object.entries(dump))
    all.set(owner, {
      season: new Map(found.season),
      tonight: { ...found.tonight, points: new Map(found.tonight.points) },
      answered: new Set(found.answered),
      rounds: found.rounds ?? []
    });
}
function scoresOf(owner) {
  const mine = scores(owner);
  return {
    tonight: {
      week: mine.tonight.week,
      teams: mine.tonight.teams,
      standings: ranked(mine.tonight.points)
    },
    rounds: mine.rounds
  };
}
var ranked = (points) => [...points.entries()].map(([team, value]) => ({ team, points: value })).sort((a, b) => b.points - a.points || a.team.localeCompare(b.team));
function registerTeams(owner, names) {
  const tonight = week(owner);
  if (!tonight) throw new Error("call start_night before registering teams");
  const teams = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (!teams.length || teams.length > 20)
    throw new Error("a night has between 1 and 20 teams");
  const mine = scores(owner);
  mine.tonight = {
    week: tonight,
    teams,
    points: new Map(teams.map((team) => [team, 0]))
  };
  const result = teams.map((name) => ({
    name,
    regular: mine.season.has(name)
  }));
  for (const team of teams) {
    const record2 = mine.season.get(team) ?? { nights: 0, points: 0 };
    record2.nights += 1;
    mine.season.set(team, record2);
  }
  return { week: tonight, teams: result };
}
function submitRound(owner, answers, recorder) {
  const mine = scores(owner);
  const tonight = mine.tonight;
  if (tonight.week !== week(owner) || !tonight.teams.length)
    throw new Error("register tonight's teams before submitting a round");
  for (const { question_id, team } of answers) {
    if (!tonight.teams.includes(team))
      throw new Error(`"${team}" is not one of tonight's teams`);
    if (!servedIn(owner, question_id, tonight.week))
      throw new Error(`question ${question_id} was not asked tonight`);
    if (mine.answered.has(`${tonight.week}:${question_id}:${team}`))
      throw new Error(`"${team}" already answered ${question_id}`);
  }
  const round = /* @__PURE__ */ new Map();
  const questions = /* @__PURE__ */ new Map();
  for (const { question_id, team, answer } of answers) {
    const mark2 = recordAnswer(owner, question_id, answer);
    mine.answered.add(`${tonight.week}:${question_id}:${team}`);
    let entry = questions.get(question_id);
    if (!entry)
      questions.set(
        question_id,
        entry = {
          question_id,
          accepted_answer: mark2.accepted_answer,
          marks: []
        }
      );
    entry.marks.push({
      team,
      answer,
      correct: mark2.correct,
      method: mark2.method
    });
    round.set(team, (round.get(team) ?? 0) + (mark2.correct ? 1 : 0));
    if (mark2.correct) {
      tonight.points.set(team, (tonight.points.get(team) ?? 0) + 1);
      mine.season.get(team).points += 1;
    }
  }
  mine.rounds.push({ week: tonight.week, ids: [...questions.keys()] });
  const marks = [...questions.values()].flatMap((entry) => entry.marks);
  const count = (method) => marks.filter((mark2) => mark2.method === method).length;
  recorder?.(
    owner,
    "bank.marked",
    `Marked ${marks.length} answers: ${marks.filter((mark2) => mark2.correct).length} right (${count("close")} close calls), ${count("wrong")} wrong, ${count("blank")} blank`,
    { questions: [...questions.values()] }
  );
  return {
    questions: [...questions.values()],
    round_points: ranked(round),
    standings: ranked(tonight.points)
  };
}
function scoreboard(owner, scope) {
  const mine = scores(owner);
  if (scope === "tonight")
    return { scope, standings: ranked(mine.tonight.points) };
  return {
    scope,
    standings: [...mine.season.entries()].map(([team, record2]) => ({ team, ...record2 })).sort((a, b) => b.points - a.points || a.team.localeCompare(b.team))
  };
}

// lib/state.ts
var FILE = process.env.TRIVIA_STATE_FILE;
var store4 = globalThis;
function loadState() {
  if (!FILE || store4.__triviaLoaded) return;
  store4.__triviaLoaded = true;
  if (!existsSync(FILE)) return;
  const saved = JSON.parse(readFileSync(FILE, "utf8"));
  loadBank(saved.bank ?? {});
  loadScores(saved.scores ?? {});
}
function saveState() {
  if (!FILE) return;
  const next = `${FILE}.next`;
  writeFileSync(
    next,
    JSON.stringify({ bank: dumpBank(), scores: dumpScores() })
  );
  renameSync(next, FILE);
}

// lib/mcp.ts
var PROTOCOL_VERSION = "2025-06-18";
var TOOLS = [
  {
    name: "start_night",
    description: "Start this venue's next quiz night. Returns its week number. Call once before the first round.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "register_teams",
    description: "Set tonight's teams by name, after start_night. Returns which teams have played at this venue before.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20
        }
      },
      required: ["names"],
      additionalProperties: false
    }
  },
  {
    name: "next_questions",
    description: "Get questions this venue has never been asked. The bank excludes every question already asked here, so never track that yourself. When the filter runs dry it is relaxed and `relaxed` says how.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 10 },
        genre: { type: "string", enum: GENRES },
        region: { type: "string", enum: ["global", "au", "uk", "us"] },
        difficulty: { type: "integer", minimum: 1, maximum: 5 }
      },
      required: ["count"],
      additionalProperties: false
    }
  },
  {
    name: "submit_round",
    description: "Submit one round's answer sheet: every team's answer to every question in the round, in one call. The bank marks each answer; never mark one yourself. An empty answer is a blank. Returns each mark, the round's points and tonight's standings.",
    inputSchema: {
      type: "object",
      properties: {
        answers: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              question_id: { type: "string" },
              team: { type: "string" },
              answer: { type: "string" }
            },
            required: ["question_id", "team", "answer"],
            additionalProperties: false
          }
        }
      },
      required: ["answers"],
      additionalProperties: false
    }
  },
  {
    name: "round_summary",
    description: "How this venue answered in one week, by genre and by difficulty; the current week when `week` is omitted.",
    inputSchema: {
      type: "object",
      properties: { week: { type: "integer", minimum: 1 } },
      additionalProperties: false
    }
  },
  {
    name: "scoreboard",
    description: "The standings: tonight's, or the season's across every night.",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["tonight", "season"] } },
      required: ["scope"],
      additionalProperties: false
    }
  }
];
var store5 = globalThis;
var sessions = store5.__triviaSessions ??= /* @__PURE__ */ new Set();
var text = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...isError && { isError }
});
function call(owner, name, args) {
  try {
    switch (name) {
      case "start_night":
        return text({ week: nextWeek(owner) });
      case "register_teams":
        return text(registerTeams(owner, args.names ?? []));
      case "next_questions":
        return text(
          nextQuestions(
            owner,
            {
              count: Math.min(10, Math.max(1, Number(args.count) || 1)),
              genre: args.genre,
              region: args.region,
              difficulty: args.difficulty ? Number(args.difficulty) : void 0
            },
            record
          )
        );
      case "submit_round":
        return text(
          submitRound(owner, args.answers ?? [], record)
        );
      case "round_summary":
        return text(summary(owner, args.week ? Number(args.week) : void 0));
      case "scoreboard":
        return text(
          scoreboard(owner, args.scope === "season" ? "season" : "tonight")
        );
      default:
        return text({ error: `unknown tool ${name}` }, true);
    }
  } catch (error) {
    return text({ error: error.message }, true);
  }
}
var sse = (message2, session) => new Response(`event: message
data: ${JSON.stringify(message2)}

`, {
  headers: { "content-type": "text/event-stream", "mcp-session-id": session }
});
var failure = (status, id, message2) => Response.json(
  { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: message2 } },
  { status }
);
async function serve2(request) {
  loadState();
  let message2;
  try {
    message2 = await request.json();
  } catch {
    return failure(400, void 0, "body must be a JSON-RPC message");
  }
  let owner = "";
  if (message2.method === "tools/call") {
    try {
      owner = await ownerOf(request);
    } catch (error) {
      if (error instanceof Unidentified)
        return failure(401, message2.id, error.message);
      throw error;
    }
  }
  if (message2.method === "initialize") {
    const id2 = crypto.randomUUID();
    sessions.add(id2);
    return sse(
      {
        jsonrpc: "2.0",
        id: message2.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "trivia-bank", version: "0.1.0" }
        }
      },
      id2
    );
  }
  const id = request.headers.get("mcp-session-id") ?? "";
  if (!sessions.has(id))
    return failure(404, message2.id, "unknown mcp-session-id");
  if (message2.method.startsWith("notifications/"))
    return new Response(null, { status: 202 });
  if (message2.method === "tools/list")
    return sse(
      { jsonrpc: "2.0", id: message2.id, result: { tools: TOOLS } },
      id
    );
  if (message2.method === "tools/call") {
    const result = call(
      owner,
      String(message2.params?.name ?? ""),
      message2.params?.arguments ?? {}
    );
    saveState();
    return sse({ jsonrpc: "2.0", id: message2.id, result }, id);
  }
  return failure(400, message2.id, `unsupported method ${message2.method}`);
}
function close2(request) {
  sessions.delete(request.headers.get("mcp-session-id") ?? "");
  return new Response(null, { status: 204 });
}

// lib/rooms.ts
function roomState(owner) {
  const asked = askedRecords(owner);
  const byId = new Map(asked.map((item) => [item.question_id, item]));
  const { tonight, rounds } = scoresOf(owner);
  const now = week(owner);
  const submitted = new Set(rounds.flatMap((round) => round.ids));
  const question = (id) => QUESTIONS.find((item) => item.id === id);
  return {
    owner,
    week: now,
    teams: tonight.week === now ? tonight.teams : [],
    standings: tonight.week === now ? tonight.standings : [],
    pending: asked.filter((item) => item.week === now && !submitted.has(item.question_id)).map((item) => ({
      id: item.question_id,
      genre: item.genre,
      region: question(item.question_id).region,
      difficulty: item.difficulty
    })),
    rounds: rounds.map((round) => {
      const items = round.ids.map((id) => byId.get(id));
      return {
        week: round.week,
        question_ids: round.ids,
        genres: items.map((item) => item.genre),
        regions: round.ids.map((id) => question(id).region),
        difficulties: items.map((item) => item.difficulty),
        answers: items.reduce((sum, item) => sum + item.answers, 0),
        correct: items.reduce((sum, item) => sum + item.correct, 0),
        blanks: items.reduce((sum, item) => sum + item.blanks, 0)
      };
    })
  };
}

// scripts/bank-server.ts
var PORT = Number(process.env.PORT ?? 8e3);
createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
  const request = new Request(url, {
    method: incoming.method,
    headers: incoming.headers,
    body: ["GET", "HEAD"].includes(incoming.method ?? "") ? void 0 : Buffer.concat(chunks)
  });
  let response;
  if (url.pathname === "/mcp" && request.method === "POST") response = await serve2(request);
  else if (url.pathname === "/mcp" && request.method === "DELETE") response = close2(request);
  else if (url.pathname === "/rooms" && request.method === "GET")
    response = Response.json(roomState(url.searchParams.get("owner") ?? process.env.TRIVIA_DEV_OWNER ?? ""));
  else if (url.pathname === "/health") response = new Response("ok");
  else response = new Response(null, { status: 404 });
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, "0.0.0.0", () => console.log(`trivia bank on :${PORT}`));
