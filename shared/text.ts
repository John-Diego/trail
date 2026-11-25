// Text that did not come from Trail itself (git and gh output, anything a remote server or a
// pull request author wrote) is passed through here before it is shown.

/**
 * The text with control characters replaced by spaces, keeping line breaks. A terminal acts
 * on control characters: without this, a server's message could retitle the window, hide
 * what follows or write to the clipboard. Characters that reorder text are removed as well.
 */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ').replace(/[‎‏‪-‮⁦-⁩﻿]/g, '')
}
