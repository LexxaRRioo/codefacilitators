import * as core from '@actions/core'
import * as github from '@actions/github'
import { Context } from '@actions/github/lib/context'
import type { GitHub } from '@actions/github/lib/utils'
import { promises as fs } from 'fs'
import picomatch from 'picomatch'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const context: Context = github?.context
    const githubToken: string = core.getInput('token')
    const file: string = core.getInput('file')

    if (!githubToken) {
      core.setFailed(`Required input "token" not provided`)
    }
    if (!file) {
      core.setFailed(`Required input "file" not provided`)
    }
    if (!hasValidOwnerInContext(context)) {
      return core.setFailed(`Valid owner is missing from context`)
    }
    if (!hasValidRepoInContext(context)) {
      return core.setFailed(`Valid repo is missing from context`)
    }
    if (!hasValidPullRequestNumberInContext(context)) {
      return core.setFailed(`Valid Pull Request number is missing from context`)
    }

    core.setSecret(githubToken)
    const octokit = github.getOctokit(githubToken)

    // Read the file
    const data = await fs.readFile(file, 'utf-8')

    core.debug(`File data: ${data}`)

    const changedFiles: string[] = context?.payload?.pull_request?.changed_files
    const reviewers = await parseFileData(data, changedFiles, octokit)

    await octokit.rest.pulls.requestReviewers({
      owner: context?.repo?.owner,
      repo: context?.repo?.repo,
      pull_number: Number(context?.payload?.pull_request?.number),
      reviewers
    })

    core.setOutput(
      'The following reviewers have been requested',
      reviewers.join(', ')
    )
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function parseFileData(
  data: string,
  changedFiles: string[],
  octokit: InstanceType<typeof GitHub>
): Promise<string[]> {
  const reviewers: string[] = []

  for (const file of changedFiles) {
    for (const line of data.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') {
        core.info(`Skipping comment or empty line: ${line}`)
        continue
      }

      const parsedLined = line.replace(/\s+/g, ' ').split(' ')
      if (parsedLined.length < 2) {
        core.info(`Skipping incorrect line: ${line}`)
        continue
      }

      const isMatch = picomatch(parsedLined[0])
      if (isMatch(file)) {
        for (const reviewer of parsedLined.slice(1)) {
          if (reviewer.includes('/')) {
            const groupsSplitted = reviewer.split('/')
            const { data: members } = await octokit.rest.teams.listMembersInOrg(
              {
                org: groupsSplitted[0],
                team_slug: groupsSplitted[1]
              }
            )
            reviewers.concat(members.map(member => member.login))
          } else {
            reviewers.push(reviewer)
          }
        }
      }
    }
  }

  return reviewers
}

function hasValidOwnerInContext(context: Context): boolean {
  return !!context?.repo?.owner
}

function hasValidRepoInContext(context: Context): boolean {
  return !!context?.repo?.repo
}

function hasValidPullRequestNumberInContext(context: Context): boolean {
  return !!Number(context?.payload?.pull_request?.number)
}
