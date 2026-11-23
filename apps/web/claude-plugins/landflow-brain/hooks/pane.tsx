/**
 * The pane (docs/landflow-brain-mod.md): Today, Yesterday and Related colleagues as one-column cards. It is opened only by
 * `/brain` or `/brain sync`, and closes with Esc. What it draws is clipped data from `paneModel`; a card of the person's
 * own work has a "Post as my update" button, which asks first.
 */
import type { EngineInterface } from 'claude-code'
import type { View } from './journal'
import { paneModel } from './journal'

export const PANE_ID = 'brain'

export function drawPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], view: View | undefined, post: (sourceId: string, source?: string) => Promise<void>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const model = paneModel(view)
  return (
    <Box flexDirection="column">
      {model.sections.map(section => (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{section.title}</Text>
          {section.cards.length === 0 && <Text dimColor>{section.empty}</Text>}
          {section.cards.map(card => (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text wrap="wrap">{card.text}</Text>
              {card.link && <Text dimColor>{card.link}</Text>}
              {card.postId && <Button key={`post-${card.postId}`} label="Post as my update" onPress={() => post(card.postId!, card.postSource)} />}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/** The band's one line, with a button that dismisses it for the day. */
export function drawBand($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], line: string, dismiss: () => unknown) {
  const { Box, Button, Text } = $.ui.resolve(e)
  return (
    <Box>
      <Text dimColor>{line} </Text>
      <Button key="dismiss" label="Dismiss" onPress={dismiss} />
    </Box>
  )
}
