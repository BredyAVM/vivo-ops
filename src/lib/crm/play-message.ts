export type PlayMessageValues = {
  clientName: string;
  advisorName: string;
  benefitLabel: string;
  validityLabel: string;
};

const tokenDefinitions: Array<[RegExp, keyof PlayMessageValues]> = [
  [/\{nombre\}|\[nombre\]/gi, 'clientName'],
  [/\{asesor\}|\[asesor\]/gi, 'advisorName'],
  [/\{beneficio\}|\[beneficio\]/gi, 'benefitLabel'],
  [/\{vigencia\}|\[vigencia\]/gi, 'validityLabel'],
];

export function renderPlayMessage(template: string, values: PlayMessageValues) {
  return tokenDefinitions.reduce(
    (message, [pattern, key]) => message.replace(pattern, () => values[key]),
    template,
  );
}
