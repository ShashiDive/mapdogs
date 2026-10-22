// Every word the contributor sees, in one place so Marathi and Hindi
// can be added later (NFR-05) without touching the rest of the code.
const en = {
  back: 'Back',
  step: 'Step {n} of {total}',
  step_photos: 'Photos',
  step_which: 'Which dog',
  step_checks: 'Quick checks',
  step_details: 'Details',
  skip_rest: 'Skip the rest',
  next: 'Next',

  setup_title: 'Setup needed',
  setup_lead: 'Add your Supabase Project URL and publishable key to config.js, then reload this page.',

  welcome_title: "Help map Pune's street dogs",
  welcome_lead: 'Photograph a dog you see. Each dog gets its own ID, so volunteers can track which dogs are sterilised, vaccinated or need help.',
  start: 'Start',
  have_code: 'I have a contributor code',

  consent_title: 'Before you start',
  consent_1: 'We save your photo, where it was taken and the nickname you choose. No phone number or email.',
  consent_2: 'A person checks every photo before anyone else sees it. Exact spots are never shown publicly.',
  consent_3: 'Dog photos and locations may be shared with animal welfare groups to help the dogs.',
  consent_safety: 'Stay safe: photograph from a distance. Never approach, corner or touch a dog for a photo.',
  agree: 'I agree',

  nick_title: 'Choose a nickname',
  nick_lead: 'It appears on the leaderboard. Use a nickname, not your full name.',
  nick_label: 'Nickname',
  nick_placeholder: 'e.g. Riya',
  nick_error: 'Use 2 to 20 characters.',
  mic_hint: 'Tip: tap the microphone on your keyboard to speak instead of typing.',

  code_title: 'Your contributor code',
  code_lead: 'Take a screenshot now. This code brings your contributions back if you change phones or clear your browser.',
  code_saved: "I've saved it",
  copy: 'Copy',
  copied: 'Copied',

  home_title: 'Welcome back, {name}',
  home_stats_one: '{approved} approved sighting',
  home_stats: '{approved} approved sightings',
  home_waiting: '{n} waiting for review',
  home_rank: "You're number {rank} on the leaderboard.",
  home_first: 'Your first approved sighting puts you on the leaderboard.',
  home_blocked: "This phone can't send sightings right now.",
  photograph: 'Photograph a dog',
  my_contrib: 'My contributions',

  loc_title: 'Allow your location',
  loc_lead: 'It puts the dog on the map. The public map only shows the area, never the exact spot.',
  loc_allow: 'Allow location',

  cap_title: 'Photograph the dog',
  cap_lead: 'One dog, close and clear. Keep a safe distance.',
  take_photo: 'Take a photo',
  from_gallery: 'Upload from gallery',

  preparing: 'Preparing your photo…',
  photo_error: "That photo couldn't be opened. Try taking it again.",
  angle_title: 'Which view is this?',
  angle_lead: 'Tap the view to use this photo.',
  warn_dark: 'This photo looks dark. Retake it in better light, or keep it.',
  warn_blurry: 'This photo looks blurry. Hold still and retake, or keep it.',
  retake: 'Retake',
  angle_face: 'Face',
  angle_left: 'Left side',
  angle_right: 'Right side',
  angle_nose: 'Nose close-up',
  angle_full: 'Full body',
  angle_other: 'Something else',
  added: 'added',

  more_title: 'Add another view?',
  more_lead: 'More views help recognise this dog later.',
  more_count: '{n} of 5 photos',
  more_try: 'Still useful: {list}.',
  add_photo: 'Add photo',
  done_photos: "I'm done",

  locating: 'Finding your location…',
  pin_title: 'Where did you see this dog?',
  pin_lead: 'Move the map until the pin sits on the spot.',
  pin_confirm: 'This is the spot',
  pin_loading: 'Loading map…',

  which_title: 'Is it one of these?',
  which_lead: 'Dogs recorded within 500 m. Tap one to compare.',
  which_loading: 'Looking for dogs near here…',
  which_empty: 'No dogs recorded near here yet. This could be the first.',
  which_error: "Couldn't load nearby dogs. You can still add this as a new dog or choose Not sure.",
  new_dog: "It's a new dog",
  not_sure: 'Not sure',
  seen: 'seen {when}',
  under_review: 'Under review',
  metres_away: '{m} m away',

  compare_lead: 'Is this the same dog?',
  your_photo: 'Your photo',
  their_photos: 'Photos of {name}',
  yes_same: "Yes, it's {name}",
  no_back: 'No, go back',

  ear_title: 'Does it have a notch cut in one ear?',
  ear_lead: 'A notched ear usually means the dog has been sterilised.',
  collar_title: 'Is it wearing a collar or tag?',
  injured_title: 'Does it look injured or unwell?',
  yes: 'Yes',
  no: 'No',
  cant_see: "Can't see",

  name_title: 'Give this dog a name?',
  name_label: 'Name',
  name_placeholder: 'e.g. Bhura',
  sex_title: 'Is it male or female?',
  male: 'Male',
  female: 'Female',
  unknown: 'Not sure',
  age_title: 'How old does it look?',
  puppy: 'Puppy',
  adult: 'Adult',
  senior: 'Senior',
  notes_title: 'Anything that makes it easy to recognise?',
  notes_label: 'Notes',
  notes_placeholder: 'e.g. white patch on chest, limps on left leg',

  uploading: 'Sending your sighting…',
  uploading_photo: 'Photo {i} of {n}',
  saving: 'Saving…',

  thanks_title: 'Submitted',
  thanks_new: 'This dog is',
  thanks_known: 'Added to {name}. {name} now has {n} photos.',
  thanks_more: 'Photos added to {name}.',
  thanks_unsure: "Thanks. We'll work out which dog this is during review.",
  thanks_review: "It shows on the map once it's checked, usually within a day.",
  add_more: 'Add more photos of this dog',
  another: 'Photograph another dog',
  home: 'Home',

  mine_title: 'My contributions',
  mine_code: 'Your contributor code',
  mine_empty: 'No sightings yet. Your first dog is out there.',
  st_waiting: 'Waiting for review',
  st_approved: 'Approved',
  st_rejected: 'Not approved',
  st_deleted: 'Removed',
  unsure_dog: 'Dog not identified yet',
  photos_n: '{n} photos',
  photos_1: '1 photo',

  restore_title: 'Enter your contributor code',
  restore_lead: 'It looks like RIYA-7KQ2XM. Capital or small letters both work.',
  restore_label: 'Contributor code',
  restore: 'Restore my contributions',
  restore_notfound: "That code wasn't found. Check it and try again.",

  err_title: "That didn't go through",
  err_network: "Couldn't reach the server. Check your internet connection and try again.",
  err_rate: "You've sent a lot of sightings this hour. Try again later.",
  err_blocked: "This phone can't send sightings right now.",
  err_too_many: 'Too many wrong codes. Wait an hour and try again.',
  err_signin: "Couldn't start a session. Check your connection and try again.",
  err_generic: 'Something unexpected happened. Try again.',
  try_again: 'Try again',

  today: 'today',
  yesterday: 'yesterday',
  days_ago: '{n} days ago',
};

const languages = { en };
let current = 'en';

export function setLanguage(code) {
  if (languages[code]) current = code;
  document.documentElement.lang = current;
}

export function t(key, vars = {}) {
  let s = (languages[current] && languages[current][key]) ?? en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
