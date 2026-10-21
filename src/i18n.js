// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration buttons, connection status),
// in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');

const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120
    ? both(`${s} s ago`, `il y a ${s} s`)
    : both(`${Math.round(s / 60)} min ago`, `il y a ${Math.round(s / 60)} min`);
};

export const T = {
  found: (lines) =>
    lines.length === 0
      ? both(
          'No KEF speaker answers yet. Type the IP address of each speaker in the configuration and save; the addresses are read at the pace of the interval.',
          "Aucune enceinte KEF ne répond encore. Saisissez l'adresse IP de chaque enceinte dans la configuration et enregistrez ; les adresses sont lues au rythme de l'intervalle.",
        )
      : both(
          `Known: ${list(lines)}. Create them from the Discovery tab.`,
          `Connues : ${list(lines)}. Créez-les depuis l'onglet Découverte.`,
        ),
  noDevice: both(
    'No speaker known yet: type their IP addresses in the configuration.',
    'Aucune enceinte connue : saisissez leurs adresses IP dans la configuration.',
  ),
  check: (lines, maxVolume) => ({
    en: [...lines.map((l) => l.en), `Volume cap: ${maxVolume} %`].join(' · '),
    fr: [...lines.map((l) => l.fr), `Plafond de volume : ${maxVolume} %`].join(' · '),
  }),
  /** The last read of a speaker (the button never reads it again sooner than the interval). */
  checkLine: (label, state, age) => {
    if (state === null || state === undefined) {
      return both(
        `${label}: not answering (off, unplugged or unreachable)`,
        `${label} : ne répond pas (éteinte, débranchée ou injoignable)`,
      );
    }
    const when = age === undefined ? both('', '') : ago(age);
    const en = [state.on === true ? 'on' : state.on === false ? 'standby' : 'power unknown'];
    const fr = [
      state.on === true ? 'allumée' : state.on === false ? 'en veille' : 'marche inconnue',
    ];
    if (Number.isInteger(state.volume)) {
      en.push(`volume ${state.volume}`);
      fr.push(`volume ${state.volume}`);
    }
    if (typeof state.source === 'string' && state.on !== false) {
      en.push(`source ${state.source}`);
      fr.push(`source ${state.source}`);
    }
    return both(
      `${label}: ${en.join(', ')} (read ${when.en})`,
      `${label} : ${fr.join(', ')} (lu ${when.fr})`,
    );
  },
  unreachable: (names) =>
    both(
      `Not answering (off, unplugged or unreachable), tried again at spaced intervals: ${list(names)}.`,
      `Ne répondent pas (éteintes, débranchées ou injoignables), réessayées à intervalles espacés : ${list(names)}.`,
    ),
  addressUnknown: (names) =>
    both(
      `Address unknown (another speaker answers at the old one): ${list(names)}. Type the new address in the configuration.`,
      `Adresse inconnue (une autre enceinte répond à l'ancienne) : ${list(names)}. Saisissez la nouvelle adresse dans la configuration.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No KEF speaker answers yet at: ${list(addresses)}.`,
      `Aucune enceinte KEF ne répond encore à : ${list(addresses)}.`,
    ),
  duplicates: (pairs) =>
    both(
      `Same speaker typed twice, read at one address only (duplicate = address read): ${list(pairs)}.`,
      `Même enceinte saisie deux fois, lue à une seule adresse (doublon = adresse lue) : ${list(pairs)}.`,
    ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignorés dans la configuration (invalides) : ${list(entries)}.`,
    ),
  dataReset: both(
    'The saved speaker list was unreadable and was reset; the speakers are found again from their addresses.',
    'La liste enregistrée des enceintes était illisible et a été réinitialisée ; les enceintes sont retrouvées par leurs adresses.',
  ),
};
