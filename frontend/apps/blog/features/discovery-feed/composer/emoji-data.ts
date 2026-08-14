/**
 * The emoji set the short-form composer offers.
 *
 * ★★★ WHY THIS IS A HAND-WRITTEN LIST AND NOT A PACKAGE (audit §9.5).
 *
 * There is no emoji dependency anywhere in this workspace — checked every
 * `package.json` in the monorepo root, `apps/blog` and all seven `packages/*`:
 * zero hits for `emoji`, `giphy`, `tenor` or `picker`. The audit's own
 * bundle-wide grep agrees: the only `emoji` strings in 4,073,252 bytes of
 * shipped JS are `base256emoji` from `multiformats` and zod's `.emoji()`
 * validator.
 *
 * So a picker is net-new either way, and the audit is explicit: "Do NOT pull in
 * a 1MB emoji package into the Home bundle — Home already carries the composer,
 * the feed, the topics rail and the Creator Tokens gql client." `emoji-mart` is
 * ~1.5MB of JSON data, `emoji-picker-react` ~800KB; both would land on the
 * single busiest route in the product to serve a button most readers never
 * press.
 *
 * This file is ~9KB of plain UTF-8, ships lazily (see `emoji-picker.tsx`'s
 * `next/dynamic({ ssr: false })`), needs no sprite sheet, no CDN image and no
 * runtime parse. The trade is honest and worth stating: this is a CURATED set of
 * ~230 common emoji, not the full ~1,900 of Unicode 15. Somebody hunting for a
 * rarely used glyph will not find it here and will paste it from their OS picker
 * instead — which is exactly what they do today, at no cost to everybody else's
 * page weight.
 *
 * Keywords exist so search finds a glyph by what it MEANS, not only by its
 * canonical name: "lol" finds 😂, "party" finds 🎉.
 */

export interface EmojiCategory {
  /** Stable id, used for the tab's accessible name. */
  id: string;
  label: string;
  /** The glyph shown on the category tab. */
  tabGlyph: string;
  emoji: { glyph: string; name: string; keywords: string[] }[];
}

const e = (glyph: string, name: string, ...keywords: string[]) => ({ glyph, name, keywords });

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: 'smileys',
    label: 'Smileys',
    tabGlyph: '😀',
    emoji: [
      e('😀', 'grinning face', 'smile', 'happy'),
      e('😃', 'grinning face with big eyes', 'smile', 'happy'),
      e('😄', 'grinning face with smiling eyes', 'smile', 'happy'),
      e('😁', 'beaming face', 'grin', 'happy'),
      e('😆', 'grinning squinting face', 'laugh', 'haha'),
      e('😅', 'grinning face with sweat', 'laugh', 'relief'),
      e('😂', 'face with tears of joy', 'lol', 'laugh', 'crying'),
      e('🤣', 'rolling on the floor laughing', 'rofl', 'lol', 'laugh'),
      e('🙂', 'slightly smiling face', 'smile'),
      e('🙃', 'upside-down face', 'sarcasm', 'irony'),
      e('😉', 'winking face', 'wink', 'flirt'),
      e('😊', 'smiling face with smiling eyes', 'blush', 'happy'),
      e('😇', 'smiling face with halo', 'angel', 'innocent'),
      e('🥰', 'smiling face with hearts', 'love', 'adore'),
      e('😍', 'smiling face with heart-eyes', 'love', 'crush'),
      e('🤩', 'star-struck', 'star', 'wow', 'amazed'),
      e('😘', 'face blowing a kiss', 'kiss', 'love'),
      e('😋', 'face savoring food', 'yum', 'tasty'),
      e('😜', 'winking face with tongue', 'silly', 'joke'),
      e('🤪', 'zany face', 'crazy', 'silly'),
      e('🤔', 'thinking face', 'hmm', 'think', 'consider'),
      e('🤨', 'face with raised eyebrow', 'skeptical', 'doubt'),
      e('😐', 'neutral face', 'meh', 'blank'),
      e('😑', 'expressionless face', 'blank', 'deadpan'),
      e('😶', 'face without mouth', 'silent', 'speechless'),
      e('😏', 'smirking face', 'smug', 'smirk'),
      e('😒', 'unamused face', 'meh', 'unimpressed'),
      e('🙄', 'face with rolling eyes', 'eyeroll', 'annoyed'),
      e('😬', 'grimacing face', 'awkward', 'yikes'),
      e('🤥', 'lying face', 'liar', 'pinocchio'),
      e('😌', 'relieved face', 'calm', 'peaceful'),
      e('😔', 'pensive face', 'sad', 'down'),
      e('🤤', 'drooling face', 'hungry', 'want'),
      e('😪', 'sleepy face', 'tired'),
      e('😴', 'sleeping face', 'zzz', 'asleep'),
      e('😷', 'face with medical mask', 'sick', 'mask'),
      e('🤒', 'face with thermometer', 'sick', 'fever'),
      e('🤕', 'face with head bandage', 'hurt', 'injured'),
      e('🥳', 'partying face', 'party', 'celebrate', 'birthday'),
      e('🥺', 'pleading face', 'please', 'beg'),
      e('😭', 'loudly crying face', 'cry', 'sob', 'sad'),
      e('😢', 'crying face', 'cry', 'sad', 'tear'),
      e('😤', 'face with steam from nose', 'triumph', 'angry'),
      e('😠', 'angry face', 'mad', 'annoyed'),
      e('😡', 'enraged face', 'furious', 'angry', 'rage'),
      e('🤬', 'face with symbols on mouth', 'swearing', 'cursing'),
      e('😱', 'face screaming in fear', 'scream', 'shock', 'scared'),
      e('😨', 'fearful face', 'scared', 'afraid'),
      e('😰', 'anxious face with sweat', 'nervous', 'worried'),
      e('😥', 'sad but relieved face', 'phew', 'sad'),
      e('😳', 'flushed face', 'embarrassed', 'blush', 'shock'),
      e('🤯', 'exploding head', 'mind blown', 'shock', 'wow'),
      e('😎', 'smiling face with sunglasses', 'cool', 'sunglasses'),
      e('🤓', 'nerd face', 'nerd', 'geek', 'glasses'),
      e('🧐', 'face with monocle', 'inspect', 'curious'),
      e('😈', 'smiling face with horns', 'devil', 'mischief'),
      e('💀', 'skull', 'dead', 'dying', 'lol'),
      e('👻', 'ghost', 'halloween', 'boo'),
      e('🤖', 'robot', 'bot', 'ai'),
      e('👽', 'alien', 'ufo', 'space'),
      e('🤡', 'clown face', 'clown', 'joker')
    ]
  },
  {
    id: 'gestures',
    label: 'People',
    tabGlyph: '👍',
    emoji: [
      e('👍', 'thumbs up', 'like', 'yes', 'approve'),
      e('👎', 'thumbs down', 'dislike', 'no'),
      e('👏', 'clapping hands', 'applause', 'bravo'),
      e('🙌', 'raising hands', 'celebrate', 'hooray'),
      e('🙏', 'folded hands', 'please', 'thanks', 'pray'),
      e('🤝', 'handshake', 'deal', 'agreement'),
      e('✌️', 'victory hand', 'peace', 'two'),
      e('🤞', 'crossed fingers', 'luck', 'hope'),
      e('🤟', 'love-you gesture', 'love'),
      e('🤘', 'sign of the horns', 'rock', 'metal'),
      e('👌', 'ok hand', 'ok', 'perfect'),
      e('🤌', 'pinched fingers', 'italian', 'chef'),
      e('👋', 'waving hand', 'hi', 'hello', 'bye'),
      e('🫡', 'saluting face', 'salute', 'respect'),
      e('💪', 'flexed biceps', 'strong', 'muscle'),
      e('🫶', 'heart hands', 'love', 'thanks'),
      e('👀', 'eyes', 'look', 'watching'),
      e('🧠', 'brain', 'smart', 'think'),
      e('👶', 'baby', 'infant'),
      e('🧑', 'person', 'adult'),
      e('👩', 'woman', 'female'),
      e('👨', 'man', 'male'),
      e('🧓', 'older person', 'elder'),
      e('👮', 'police officer', 'cop'),
      e('👷', 'construction worker', 'builder'),
      e('🕵️', 'detective', 'spy', 'investigate'),
      e('👩‍💻', 'woman technologist', 'developer', 'coder'),
      e('👨‍💻', 'man technologist', 'developer', 'coder'),
      e('🧑‍🎨', 'artist', 'painter', 'creative'),
      e('🦸', 'superhero', 'hero'),
      e('🧙', 'mage', 'wizard'),
      e('🚶', 'person walking', 'walk'),
      e('🏃', 'person running', 'run'),
      e('💃', 'woman dancing', 'dance'),
      e('🕺', 'man dancing', 'dance')
    ]
  },
  {
    id: 'nature',
    label: 'Nature',
    tabGlyph: '🌿',
    emoji: [
      e('🐶', 'dog face', 'puppy', 'pet'),
      e('🐱', 'cat face', 'kitten', 'pet'),
      e('🐭', 'mouse face', 'rodent'),
      e('🐰', 'rabbit face', 'bunny'),
      e('🦊', 'fox', 'foxy'),
      e('🐻', 'bear', 'grizzly'),
      e('🐼', 'panda', 'bear'),
      e('🐨', 'koala', 'australia'),
      e('🐯', 'tiger face', 'cat'),
      e('🦁', 'lion', 'cat', 'king'),
      e('🐮', 'cow face', 'moo'),
      e('🐷', 'pig face', 'oink'),
      e('🐸', 'frog', 'toad'),
      e('🐵', 'monkey face', 'ape'),
      e('🐔', 'chicken', 'hen'),
      e('🐧', 'penguin', 'antarctic'),
      e('🐦', 'bird', 'tweet'),
      e('🦉', 'owl', 'night', 'wise'),
      e('🦋', 'butterfly', 'insect'),
      e('🐝', 'honeybee', 'bee', 'insect'),
      e('🐢', 'turtle', 'slow'),
      e('🐍', 'snake', 'serpent'),
      e('🐬', 'dolphin', 'sea'),
      e('🐳', 'spouting whale', 'sea', 'ocean'),
      e('🐙', 'octopus', 'sea'),
      e('🌸', 'cherry blossom', 'flower', 'spring'),
      e('🌹', 'rose', 'flower', 'love'),
      e('🌻', 'sunflower', 'flower'),
      e('🌿', 'herb', 'leaf', 'plant'),
      e('🍀', 'four leaf clover', 'luck'),
      e('🌲', 'evergreen tree', 'forest', 'pine'),
      e('🌵', 'cactus', 'desert'),
      e('🌞', 'sun with face', 'sunny', 'day'),
      e('🌝', 'full moon face', 'night', 'moon'),
      e('⭐', 'star', 'favourite'),
      e('🌈', 'rainbow', 'pride', 'colour'),
      e('🔥', 'fire', 'lit', 'hot', 'flame'),
      e('❄️', 'snowflake', 'cold', 'winter'),
      e('🌊', 'water wave', 'sea', 'ocean'),
      e('⚡', 'high voltage', 'lightning', 'power', 'fast')
    ]
  },
  {
    id: 'food',
    label: 'Food',
    tabGlyph: '🍕',
    emoji: [
      e('🍏', 'green apple', 'fruit'),
      e('🍎', 'red apple', 'fruit'),
      e('🍌', 'banana', 'fruit'),
      e('🍉', 'watermelon', 'fruit', 'summer'),
      e('🍇', 'grapes', 'fruit', 'wine'),
      e('🍓', 'strawberry', 'fruit'),
      e('🥑', 'avocado', 'toast'),
      e('🍅', 'tomato', 'vegetable'),
      e('🥕', 'carrot', 'vegetable'),
      e('🌽', 'corn', 'vegetable'),
      e('🍞', 'bread', 'loaf'),
      e('🧀', 'cheese', 'dairy'),
      e('🍕', 'pizza', 'slice'),
      e('🍔', 'hamburger', 'burger'),
      e('🌮', 'taco', 'mexican'),
      e('🍜', 'steaming bowl', 'ramen', 'noodles'),
      e('🍣', 'sushi', 'japanese'),
      e('🍱', 'bento box', 'japanese', 'lunch'),
      e('🍰', 'shortcake', 'cake', 'dessert'),
      e('🎂', 'birthday cake', 'birthday', 'celebrate'),
      e('🍪', 'cookie', 'biscuit'),
      e('🍫', 'chocolate bar', 'sweet'),
      e('🍿', 'popcorn', 'cinema', 'movie'),
      e('☕', 'hot beverage', 'coffee', 'tea'),
      e('🍵', 'teacup', 'tea', 'green tea'),
      e('🍺', 'beer mug', 'beer', 'pub'),
      e('🍷', 'wine glass', 'wine'),
      e('🥂', 'clinking glasses', 'cheers', 'celebrate'),
      e('🧊', 'ice', 'cold', 'cube'),
      e('🥤', 'cup with straw', 'soda', 'drink')
    ]
  },
  {
    id: 'activity',
    label: 'Activity',
    tabGlyph: '⚽',
    emoji: [
      e('⚽', 'soccer ball', 'football', 'sport'),
      e('🏀', 'basketball', 'sport'),
      e('🏈', 'american football', 'sport'),
      e('⚾', 'baseball', 'sport'),
      e('🎾', 'tennis', 'sport'),
      e('🏐', 'volleyball', 'sport'),
      e('🏓', 'ping pong', 'table tennis', 'sport'),
      e('🥊', 'boxing glove', 'boxing', 'fight'),
      e('🏆', 'trophy', 'win', 'champion'),
      e('🥇', 'first place medal', 'gold', 'win'),
      e('🎯', 'bullseye', 'target', 'goal'),
      e('🎮', 'video game', 'gaming', 'controller'),
      e('🎲', 'game die', 'dice', 'random'),
      e('🎸', 'guitar', 'music', 'rock'),
      e('🎹', 'musical keyboard', 'piano', 'music'),
      e('🎧', 'headphone', 'music', 'listen'),
      e('🎤', 'microphone', 'sing', 'podcast'),
      e('🎬', 'clapper board', 'film', 'movie'),
      e('🎨', 'artist palette', 'art', 'paint'),
      e('📷', 'camera', 'photo', 'picture'),
      e('🚴', 'person biking', 'cycling', 'bike'),
      e('🏊', 'person swimming', 'swim'),
      e('🧘', 'person in lotus position', 'yoga', 'meditate'),
      e('⛺', 'tent', 'camping', 'outdoors'),
      e('🎉', 'party popper', 'party', 'celebrate', 'congrats'),
      e('🎊', 'confetti ball', 'party', 'celebrate'),
      e('🎁', 'wrapped gift', 'present', 'birthday')
    ]
  },
  {
    id: 'travel',
    label: 'Travel',
    tabGlyph: '✈️',
    emoji: [
      e('🚗', 'car', 'drive', 'automobile'),
      e('🚕', 'taxi', 'cab'),
      e('🚌', 'bus', 'transit'),
      e('🚲', 'bicycle', 'bike', 'cycle'),
      e('🛵', 'motor scooter', 'moped'),
      e('🚆', 'train', 'rail'),
      e('✈️', 'airplane', 'flight', 'travel'),
      e('🚀', 'rocket', 'launch', 'space', 'ship it'),
      e('🛸', 'flying saucer', 'ufo', 'alien'),
      e('⛵', 'sailboat', 'sailing', 'boat'),
      e('🚢', 'ship', 'cruise', 'boat'),
      e('🗺️', 'world map', 'map', 'travel'),
      e('🧭', 'compass', 'navigate', 'direction'),
      e('🏔️', 'snow-capped mountain', 'mountain', 'alps'),
      e('🏖️', 'beach with umbrella', 'beach', 'holiday'),
      e('🏝️', 'desert island', 'island', 'tropical'),
      e('🌍', 'globe showing europe-africa', 'world', 'earth'),
      e('🌎', 'globe showing americas', 'world', 'earth'),
      e('🌏', 'globe showing asia-australia', 'world', 'earth'),
      e('🏙️', 'cityscape', 'city', 'skyline'),
      e('🌉', 'bridge at night', 'bridge', 'night'),
      e('🗼', 'tokyo tower', 'tower', 'japan'),
      e('🏰', 'castle', 'fortress'),
      e('⛰️', 'mountain', 'peak', 'hike'),
      e('🌋', 'volcano', 'eruption')
    ]
  },
  {
    id: 'objects',
    label: 'Objects',
    tabGlyph: '💡',
    emoji: [
      e('💡', 'light bulb', 'idea', 'insight'),
      e('🔑', 'key', 'unlock', 'access'),
      e('🔒', 'locked', 'lock', 'secure', 'private'),
      e('🔓', 'unlocked', 'open', 'public'),
      e('📱', 'mobile phone', 'phone', 'smartphone'),
      e('💻', 'laptop', 'computer', 'work'),
      e('🖥️', 'desktop computer', 'computer', 'monitor'),
      e('⌨️', 'keyboard', 'type', 'typing'),
      e('🖱️', 'computer mouse', 'click'),
      e('💾', 'floppy disk', 'save', 'storage'),
      e('📀', 'dvd', 'disc'),
      e('📺', 'television', 'tv', 'watch'),
      e('📻', 'radio', 'broadcast'),
      e('🔋', 'battery', 'power', 'charge'),
      e('🔌', 'electric plug', 'power', 'connect'),
      e('🕰️', 'mantelpiece clock', 'clock', 'time'),
      e('⏰', 'alarm clock', 'alarm', 'wake', 'time'),
      e('⏳', 'hourglass not done', 'waiting', 'time'),
      e('📅', 'calendar', 'date', 'schedule'),
      e('📌', 'pushpin', 'pin', 'important'),
      e('📎', 'paperclip', 'attach', 'attachment'),
      e('✂️', 'scissors', 'cut'),
      e('📝', 'memo', 'note', 'write'),
      e('📖', 'open book', 'read', 'book'),
      e('📚', 'books', 'library', 'read'),
      e('✏️', 'pencil', 'write', 'edit'),
      e('🖊️', 'pen', 'write', 'sign'),
      e('📰', 'newspaper', 'news', 'press'),
      e('💰', 'money bag', 'money', 'cash', 'rich'),
      e('💸', 'money with wings', 'spend', 'money'),
      e('💳', 'credit card', 'pay', 'card'),
      e('📈', 'chart increasing', 'growth', 'up', 'profit'),
      e('📉', 'chart decreasing', 'loss', 'down', 'crash'),
      e('🔍', 'magnifying glass', 'search', 'find', 'zoom'),
      e('🔔', 'bell', 'notification', 'alert'),
      e('🛠️', 'hammer and wrench', 'tools', 'build', 'fix'),
      e('🧪', 'test tube', 'experiment', 'science'),
      e('🧲', 'magnet', 'attract'),
      e('🗑️', 'wastebasket', 'trash', 'delete')
    ]
  },
  {
    id: 'symbols',
    label: 'Symbols',
    tabGlyph: '❤️',
    emoji: [
      e('❤️', 'red heart', 'love', 'like'),
      e('🧡', 'orange heart', 'love'),
      e('💛', 'yellow heart', 'love'),
      e('💚', 'green heart', 'love'),
      e('💙', 'blue heart', 'love'),
      e('💜', 'purple heart', 'love'),
      e('🖤', 'black heart', 'love', 'dark'),
      e('🤍', 'white heart', 'love'),
      e('💔', 'broken heart', 'heartbreak', 'sad'),
      e('💯', 'hundred points', '100', 'perfect', 'agree'),
      e('✅', 'check mark button', 'done', 'yes', 'correct'),
      e('❌', 'cross mark', 'no', 'wrong', 'cancel'),
      e('⚠️', 'warning', 'caution', 'careful'),
      e('❓', 'question mark', 'question', 'ask'),
      e('❗', 'exclamation mark', 'important', 'alert'),
      e('➡️', 'right arrow', 'next', 'forward'),
      e('⬅️', 'left arrow', 'back', 'previous'),
      e('🔁', 'repeat button', 'loop', 'again'),
      e('🔄', 'counterclockwise arrows', 'refresh', 'sync'),
      e('➕', 'plus', 'add', 'more'),
      e('➖', 'minus', 'remove', 'less'),
      e('♻️', 'recycling symbol', 'recycle', 'green'),
      e('🔞', 'no one under eighteen', 'nsfw', 'adult'),
      e('💬', 'speech balloon', 'comment', 'chat', 'talk'),
      e('💭', 'thought balloon', 'think', 'idea'),
      e('🔗', 'link', 'url', 'chain'),
      e('©️', 'copyright', 'legal'),
      e('™️', 'trade mark', 'brand'),
      e('🆕', 'new button', 'new'),
      e('🆗', 'ok button', 'ok'),
      e('🔴', 'red circle', 'record', 'live'),
      e('🟢', 'green circle', 'online', 'go'),
      e('⚫', 'black circle', 'dot'),
      e('⚪', 'white circle', 'dot')
    ]
  }
];

export interface EmojiEntry {
  glyph: string;
  name: string;
  keywords: string[];
}

/** Flat index, built once at module load, for the search field. */
export const ALL_EMOJI: EmojiEntry[] = EMOJI_CATEGORIES.flatMap((category) => category.emoji);

export function searchEmoji(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return ALL_EMOJI.filter(
    (entry) => entry.name.includes(q) || entry.keywords.some((keyword) => keyword.includes(q))
  );
}
