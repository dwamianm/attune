/**
 * Turns raw Jev answers into the typed Judgments the client policy reads.
 *
 * The core judgments (readCoreJudgments, readCoreCommand) and the answer
 * readers come from @attuneui/jev; this file adds the demo's own. Every answer
 * is checked against the question that was actually sent: a Choice must pick
 * one of the options we offered, and a Score's probabilities must cover the
 * levels we wrote. Anything missing or out of shape throws, so adapt.ts can
 * fall back to the heuristic instead of handing the layout policy half a
 * judgment.
 */
import {
  certainChoice,
  choiceOptions,
  isRecord,
  JevAnswerError,
  readChoice,
  readCoreCommand,
  readCoreJudgments,
  readNoul,
  readScore,
  scoreLevels,
  type Answers,
  type QuestionMap,
} from "@attuneui/jev";
import { ACTION_IDS, CATALOG } from "../shared/catalog.ts";
import {
  INVOICE_STATUS_ARGS,
  TIMEFRAME_ARGS,
  type CommandJudgments,
  type Judgments,
  type PrepJudgments,
  type PrepRecord,
  type ScoreJudgment,
} from "../shared/types.ts";
import { CLIENT_NOT_MENTIONED, NO_CLIENT, PREP_QUESTION_IDS, QUESTION_IDS } from "./questions.ts";

function readCommand(answers: Answers, questions: QuestionMap): CommandJudgments {
  const ids = QUESTION_IDS.command;
  return {
    ...readCoreCommand(answers, CATALOG),
    invoiceStatus: readChoice(answers, ids.invoiceStatus, INVOICE_STATUS_ARGS),
    client:
      ids.client in questions
        ? readChoice(answers, ids.client, choiceOptions(questions, ids.client))
        : certainChoice<string>(CLIENT_NOT_MENTIONED),
    timeframe: readChoice(answers, ids.timeframe, TIMEFRAME_ARGS),
  };
}

/**
 * Build Judgments from `answers` (the `answers` map of a System One
 * response) for the `questions` that were sent. Throws JevAnswerError on
 * any missing or malformed answer.
 */
export function normalizeJudgments(answers: unknown, questions: QuestionMap): Judgments {
  if (!isRecord(answers)) throw new JevAnswerError("Jev response has no answers object");

  const judgments: Judgments = {
    ...readCoreJudgments(answers, questions, CATALOG),
    // No candidates means there was nothing to choose from, so code answers.
    targetClient:
      QUESTION_IDS.targetClient in questions
        ? readChoice(answers, QUESTION_IDS.targetClient, choiceOptions(questions, QUESTION_IDS.targetClient))
        : certainChoice<string>(NO_CLIENT),
  };

  // Asked only when the client sent record candidates. The options are read
  // from the question that was sent, so the pick must be one of those ids or "none".
  if (QUESTION_IDS.nextRecord in questions) {
    judgments.nextRecord = readChoice(answers, QUESTION_IDS.nextRecord, choiceOptions(questions, QUESTION_IDS.nextRecord));
  }
  if (QUESTION_IDS.listWork in questions) {
    judgments.listWork = readNoul(answers, QUESTION_IDS.listWork);
  }
  // Focus aid 2: asked only when the client sent the working goal, and task
  // candidates. The next task must be one of the task ids sent, or "none".
  if (QUESTION_IDS.goalDone in questions) {
    judgments.goalDone = readNoul(answers, QUESTION_IDS.goalDone);
  }
  if (QUESTION_IDS.nextTask in questions) {
    judgments.nextTask = readChoice(answers, QUESTION_IDS.nextTask, choiceOptions(questions, QUESTION_IDS.nextTask));
  }
  // "Arrange linked panels by next step": asked only when the client sent the
  // clicked record and its linked records. The next record must be one of the
  // linked record ids sent, or "none"; the action one of the catalog's.
  if (QUESTION_IDS.linkNext in questions) {
    judgments.linkNext = readChoice(answers, QUESTION_IDS.linkNext, choiceOptions(questions, QUESTION_IDS.linkNext));
  }
  if (QUESTION_IDS.linkAction in questions) {
    judgments.linkAction = readChoice(answers, QUESTION_IDS.linkAction, ACTION_IDS);
  }

  if (QUESTION_IDS.command.panel in questions) {
    judgments.command = readCommand(answers, questions);
  }
  return judgments;
}

/**
 * Build the meeting-prep judgments (focus aid 4) from `answers` for the
 * `questions` that were sent: one Score per record, keyed back to its record
 * id (the questions follow the order of `records`, PREP_QUESTION_IDS.record),
 * and the anything-urgent Noul. Throws JevAnswerError on any missing or
 * malformed answer, like normalizeJudgments.
 */
export function normalizePrepJudgments(answers: unknown, questions: QuestionMap, records: readonly PrepRecord[]): PrepJudgments {
  if (!isRecord(answers)) throw new JevAnswerError("Jev response has no answers object");
  const scores: Record<string, ScoreJudgment> = {};
  records.forEach((r, i) => {
    const id = PREP_QUESTION_IDS.record(i);
    scores[r.id] = readScore(answers, id, scoreLevels(questions, id));
  });
  return { scores, anythingUrgent: readNoul(answers, PREP_QUESTION_IDS.anythingUrgent) };
}
