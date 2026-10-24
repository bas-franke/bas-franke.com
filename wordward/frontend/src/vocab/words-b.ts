// Vocabulary, part B: verbs, adjectives, small words. One entry per line: `english|romanian`.
// Text in parentheses is shown as a hint but never has to be typed: "(to) eat|(a) mânca" is typed "eat" / "mânca".

export const WORDS_B: Record<string, string> = {
  verbs: `
(to) be|(a) fi
(to) have|(a) avea
(to) do|(a) face
(to) make|(a) face
(to) go|(a) merge
(to) come|(a) veni
(to) see|(a) vedea
(to) look|(a) privi
(to) watch|(a) se uita
(to) hear|(a) auzi
(to) listen|(a) asculta
(to) speak|(a) vorbi
(to) say|(a) spune
(to) tell|(a) povesti
(to) talk|(a) discuta
(to) ask|(a) întreba
(to) answer|(a) răspunde
(to) eat|(a) mânca
(to) drink|(a) bea
(to) cook|(a) găti
(to) sleep|(a) dormi
(to) wake up|(a) se trezi
(to) live|(a) trăi
(to) die|(a) muri
(to) love|(a) iubi
(to) like|(a) plăcea
(to) want|(a) vrea
(to) need|(a) avea nevoie
(to) can|(a) putea
(to) must|(a) trebui
(to) know|(a) ști
(to) know (someone)|(a) cunoaște
(to) think|(a) gândi
(to) believe|(a) crede
(to) understand|(a) înțelege
(to) learn|(a) învăța
(to) teach|(a) preda
(to) study|(a) studia
(to) read|(a) citi
(to) write|(a) scrie
(to) count|(a) număra
(to) work|(a) lucra
(to) play|(a) juca
(to) sing|(a) cânta
(to) dance|(a) dansa
(to) run|(a) alerga
(to) walk|(a) merge pe jos
(to) jump|(a) sări
(to) swim|(a) înota
(to) fly|(a) zbura
(to) drive|(a) conduce
(to) travel|(a) călători
(to) arrive|(a) ajunge
(to) leave|(a) pleca
(to) return|(a) se întoarce
(to) stay|(a) rămâne
(to) wait|(a) aștepta
(to) open|(a) deschide
(to) close|(a) închide
(to) start|(a) începe
(to) finish|(a) termina
(to) stop|(a) opri
(to) continue|(a) continua
(to) give|(a) da
(to) take|(a) lua
(to) bring|(a) aduce
(to) send|(a) trimite
(to) receive|(a) primi
(to) buy|(a) cumpăra
(to) sell|(a) vinde
(to) pay|(a) plăti
(to) cost|(a) costa
(to) find|(a) găsi
(to) lose|(a) pierde
(to) win|(a) câștiga
(to) search|(a) căuta
(to) help|(a) ajuta
(to) try|(a) încerca
(to) use|(a) folosi
(to) put|(a) pune
(to) hold|(a) ține
(to) carry|(a) căra
(to) pull|(a) trage
(to) push|(a) împinge
(to) throw|(a) arunca
(to) catch|(a) prinde
(to) break|(a) rupe
(to) fix|(a) repara
(to) build|(a) construi
(to) cut|(a) tăia
(to) wash|(a) spăla
(to) clean|(a) curăța
(to) dress|(a) se îmbrăca
(to) wear|(a) purta
(to) sit|(a) sta jos
(to) stand|(a) sta în picioare
(to) lie down|(a) se întinde
(to) fall|(a) cădea
(to) rise|(a) se ridica
(to) climb|(a) urca
(to) descend|(a) coborî
(to) enter|(a) intra
(to) exit|(a) ieși
(to) cross|(a) traversa
(to) follow|(a) urma
(to) lead|(a) conduce
(to) show|(a) arăta
(to) hide|(a) ascunde
(to) remember|(a) își aminti
(to) forget|(a) uita
(to) choose|(a) alege
(to) decide|(a) decide
(to) change|(a) schimba
(to) grow|(a) crește
(to) laugh|(a) râde
(to) smile|(a) zâmbi
(to) cry|(a) plânge
(to) shout|(a) striga
(to) call|(a) suna
(to) meet|(a) întâlni
(to) visit|(a) vizita
(to) invite|(a) invita
(to) thank|(a) mulțumi
(to) hope|(a) spera
(to) fear|(a) se teme
(to) feel|(a) simți
(to) touch|(a) atinge
(to) smell|(a) mirosi
(to) taste|(a) gusta
(to) kiss|(a) săruta
(to) hug|(a) îmbrățișa
(to) marry|(a) se căsători
(to) fight|(a) lupta
(to) defend|(a) apăra
(to) attack|(a) ataca
(to) shoot|(a) trage
(to) destroy|(a) distruge
(to) save|(a) salva
(to) protect|(a) proteja
(to) burn|(a) arde
(to) shine|(a) străluci
(to) rain|(a) ploua
(to) snow|(a) ninge
(to) begin|(a) porni
(to) happen|(a) se întâmpla
(to) seem|(a) părea
(to) become|(a) deveni
(to) belong|(a) aparține
(to) allow|(a) permite
(to) forbid|(a) interzice
(to) promise|(a) promite
(to) explain|(a) explica
(to) repeat|(a) repeta
(to) translate|(a) traduce
(to) spell|(a) silabisi
(to) draw|(a) desena
(to) paint|(a) picta
(to) plant|(a) planta
(to) rent|(a) închiria
(to) borrow|(a) împrumuta
(to) prefer|(a) prefera
(to) rest|(a) se odihni
(to) dream|(a) visa
(to) breathe|(a) respira
(to) kill|(a) ucide
(to) steal|(a) fura
(to) knock|(a) bate
(to) ring|(a) suna
`,
  adjectives: `
good|bun
bad|rău
big|mare
small|mic
long|lung
short|scurt
tall|înalt
low|jos
wide|lat
narrow|îngust
thick|gros
thin|subțire
heavy|greu
light (weight)|ușor
fast|rapid
slow|încet
new|nou
old|vechi
old (person)|bătrân
young|tânăr
hot|fierbinte
warm|cald
cold (adj)|rece
beautiful|frumos
ugly|urât
pretty|drăguț
clean|curat
dirty|murdar
full|plin
empty|gol
rich|bogat
poor|sărac
happy|fericit
sad|trist
angry|furios
tired|obosit
hungry|flămând
thirsty|însetat
sick|bolnav
healthy|sănătos
strong|puternic
weak|slab
brave|curajos
afraid|speriat
smart|deștept
stupid|prost
funny|amuzant
serious|serios
kind|amabil
polite|politicos
rude|nepoliticos
quiet|liniștit
loud|zgomotos
busy|ocupat
free (not busy)|liber
easy|ușor
difficult|dificil
hard|greu
soft|moale
sweet|dulce
sour|acru
bitter|amar
salty|sărat
spicy|picant
tasty|gustos
delicious|delicios
fresh|proaspăt
ripe|copt
raw|crud
dry|uscat
wet|ud
right (correct)|corect
wrong|greșit
true|adevărat
false|fals
important|important
interesting|interesant
boring|plictisitor
famous|celebru
strange|ciudat
normal|normal
possible|posibil
impossible|imposibil
ready|gata
open|deschis
closed|închis
near|aproape
far|departe
same|același
different|diferit
other|alt
whole|întreg
each|fiecare
only|singur
alone|singur
dear|drag
safe|sigur
dangerous|periculos
lucky|norocos
quick|iute
round|rotund
square (shape)|pătrat
straight|drept
deep|adânc
high|sus
bright|luminos
darkness|întuneric
quiet (person)|tăcut
proud|mândru
lazy|leneș
hardworking|harnic
honest|cinstit
wise|înțelept
crazy|nebun
calm|calm
nervous|nervos
jealous|gelos
shy|timid
`,
  small: `
I|eu
you|tu
he|el
she|ea
we|noi
you (plural)|voi
they|ei
you (formal)|dumneavoastră
my|meu
your|tău
our|nostru
this|acesta
that|acela
here|aici
there|acolo
what|ce
who|cine
where|unde
when|când
why|de ce
how|cum
how much|cât
which|care
and|și
or|sau
but|dar
because|pentru că
if|dacă
with|cu
without|fără
for|pentru
from|de la
to|la
in|în
on|pe
under|sub
over|peste
between|între
before|înainte
after|după
during|în timpul
until|până
very|foarte
too|prea
also|de asemenea
again|din nou
already|deja
still|încă
almost|aproape
only (just)|doar
together|împreună
all|tot
many|mulți
much|mult
few|puțini
little|puțin
more|mai mult
less|mai puțin
enough|destul
well|bine
badly|rău
quickly|repede
slowly|încet
up|sus
down|jos
inside|înăuntru
outside|afară
forward|înainte
back|înapoi
around|în jur
somewhere|undeva
nowhere|nicăieri
everywhere|peste tot
`,
  emotions: `
love|dragoste
hate|ură
joy|bucurie
sadness|tristețe
fear|frică
anger|furie
hope|speranță
happiness|fericire
peace|pace
war|război
friendship|prietenie
courage|curaj
patience|răbdare
surprise|surpriză
shame|rușine
pride|mândrie
trust|încredere
luck|noroc
longing|dor
smile|zâmbet
laughter|râs
tear|lacrimă
kiss|sărut
hug|îmbrățișare
truth|adevăr
lie|minciună
life|viață
death|moarte
soul|suflet
mind|minte
memory|amintire
freedom|libertate
beauty|frumusețe
`,
};
