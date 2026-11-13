"""Curated words for the 'switcheroo' anonymise mode (psychedelic / cosmic / organic).

Plain lowercase ASCII, one word each, no duplicates across lists (a test checks
that, plus a small blocklist). Verbs come in two flavours so a fake can match
the shape of the original: base forms and -ing forms (written out, not derived,
so spelling is always right).
"""

NOUNS = """
octopus nebula mycelium spore lichen fern moss orchid lotus petal pollen root
canopy thicket meadow lagoon tide reef coral kelp anemone urchin jellyfish
seahorse starfish manta nautilus cuttlefish barnacle plankton pearl shell
comet meteor asteroid quasar pulsar galaxy cosmos orbit eclipse equinox solstice
aurora zenith nadir horizon twilight dawn dusk midnight sunrise moonbeam stardust
constellation supernova wormhole singularity photon neutron plasma ether aether
prism crystal geode quartz amethyst obsidian opal jade amber agate onyx garnet
topaz basalt granite pebble boulder canyon cavern grotto glacier iceberg tundra
volcano ember cinder ash lava magma geyser spring brook river delta estuary
mist fog haze cloud thunder lightning monsoon breeze gale whirlwind tempest squall
raindrop snowflake frost dewdrop icicle rainbow mirage vapor smoke
owl raven crow sparrow heron crane falcon kestrel swan moth butterfly dragonfly
firefly beetle cricket cicada spider scorpion mantis hornet bee wasp ant termite
fox wolf lynx otter badger hare stag moose bison panther jaguar cobra viper gecko
lizard newt salamander toad frog tortoise turtle salmon trout carp eel pike
whale dolphin walrus penguin pelican albatross condor phoenix griffin dragon
unicorn chimera sphinx kraken golem gnome sprite pixie nymph dryad faun satyr
wizard shaman oracle pilgrim nomad hermit wanderer voyager drifter dreamer
mushroom toadstool truffle fungus bracken thistle clover nettle bramble ivy vine
willow cedar cypress juniper maple birch aspen sequoia baobab banyan bamboo palm
acorn chestnut walnut hazel pinecone seed bud stem thorn bark
saffron cinnamon nutmeg ginger clove turmeric fennel sage thyme basil mint
honey nectar syrup resin sap dew brew elixir potion tonic philter
lantern candle torch beacon lighthouse compass sextant astrolabe telescope kaleidoscope
mandala labyrinth maze spiral vortex helix fractal lattice mosaic tapestry
arch bridge tower temple shrine pagoda citadel fortress castle ruin obelisk monolith
portal gateway threshold doorway window mirror lens echo whisper murmur hum drone
rhythm cadence melody harmony chord drumbeat pulse heartbeat tempo groove riff
fable legend myth saga riddle enigma mystery secret omen vision trance reverie
daydream nightmare slumber lullaby serenade carnival circus parade festival bazaar
caravan voyage odyssey journey expedition passage trail pathway crossroads
harbor anchor mast rudder galleon schooner raft canoe kayak
balloon zeppelin rocket satellite probe capsule shuttle lunar planet moon sun
velvet silk linen satin lace denim tweed cotton wool feather fleece
marble copper bronze silver gold iron steel mercury cobalt zinc platinum
jungle savanna desert dune oasis steppe prairie valley ridge summit plateau mesa
island archipelago peninsula atoll cove bay fjord strait isthmus cliff
garden orchard grove forest woodland swamp marsh bog fen dell glade
carousel pendulum gyroscope orb sphere cube pyramid cone
tangerine mango papaya guava lychee fig plum cherry quince pomegranate
saucer mug kettle teapot lamp hammock quilt pillow cradle nest burrow hive
""".split()

VERBS_BASE = """
drift wander bloom sprout unfurl blossom wilt ripen flourish germinate
float glide soar hover swoop dive plunge surface ripple swirl eddy
shimmer glimmer glow flicker flare sparkle twinkle gleam radiate illuminate
chant sing resound resonate vibrate throb
dream imagine envision conjure summon invoke awaken stir rouse linger
roam trek sail navigate paddle meander stray ramble
climb ascend rise lift levitate elevate transcend vanish fade dissolve melt
merge blend weave braid knit spin twist coil wind loop curl unravel tangle
revolve rotate tumble roll sway rock swing dangle pivot
bend stretch expand grow swell flow stream pour cascade trickle drip seep
burn smolder kindle ignite scorch simmer steep ferment distill
carve sculpt etch paint sketch draw scribble inscribe stitch
gather harvest forage scatter sow plant bury unearth excavate discover explore
chase follow trace track seek hunt find lose forget remember recall
wake sleep doze rest nap yawn breathe inhale exhale sigh
laugh giggle grin smile dance leap bounce hop skip prance frolic
gaze stare glance peer wonder ponder muse reflect contemplate
unlock open close seal fold unfold wrap cloak veil shroud
tremble shiver quake rumble roar howl growl purr buzz chirp trill warble
submerge wade splash soak drench flood evaporate condense freeze thaw
fly flutter flap perch hatch emerge arise return depart arrive
shape mold forge temper polish gild tint dye bleach stain
tune strum pluck drum beat tap clap stomp strike chime toll ring
""".split()

VERBS_ING = """
drifting wandering blooming sprouting unfurling floating gliding soaring
hovering swooping diving rippling swirling shimmering glimmering glowing
flickering flaring sparkling twinkling gleaming whispering murmuring humming
chanting singing echoing resonating vibrating pulsing dreaming conjuring
awakening stirring lingering roaming trekking sailing paddling meandering
straying rambling climbing ascending rising lifting levitating vanishing
fading dissolving melting merging blending weaving braiding spinning twisting
coiling winding looping curling unraveling orbiting revolving rotating
tumbling rolling swaying rocking swinging dangling pivoting bending stretching
expanding growing swelling flowing streaming pouring cascading dripping
burning smoldering kindling igniting simmering brewing fermenting carving
sculpting painting sketching gathering harvesting scattering planting burying
exploring chasing following tracing seeking hunting remembering waking
sleeping dozing breathing sighing laughing dancing leaping bouncing hopping
skipping gazing wondering pondering musing reflecting unlocking opening
folding wrapping trembling shivering rumbling roaring howling purring
buzzing chirping splashing freezing fluttering emerging
returning arriving shaping forging polishing tuning strumming plucking
drumming tapping chiming tolling ringing
""".split()

VERBS = VERBS_BASE + VERBS_ING

# Small blocklist used by the tests (whole words). Not exhaustive on purpose;
# the bank is hand-written, this just guards against slips.
BLOCKLIST = {
    "fuck", "shit", "cunt", "nigger", "nazi", "rape", "slut", "whore", "bitch",
    "cock", "dick", "pussy", "fag", "retard", "kike", "spic", "chink",
}

# Original words treated as verbs even without an -ing / -ed ending.
COMMON_VERBS = {
    "run", "walk", "fly", "dance", "sing", "love", "kiss", "kill", "dream", "burn",
    "fall", "rise", "shine", "break", "make", "take", "give", "come", "go", "get",
    "let", "feel", "hold", "stay", "fight", "cry", "play", "stop", "move", "wake",
    "sleep", "hide", "see", "know", "think", "call", "need", "want", "turn", "leave",
    "bring", "keep", "ride", "drive", "jump", "swim", "fade", "shake", "rock", "roll",
    "wait", "watch", "work", "talk", "stand", "sit", "lie", "try", "believe", "remember",
}
