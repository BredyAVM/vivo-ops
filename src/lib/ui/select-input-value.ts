/** Select on entry only; later clicks can still position the caret normally. */
export function selectInputValue(event: { currentTarget: { select: () => void } }) {
  event.currentTarget.select();
}
