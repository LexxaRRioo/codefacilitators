import * as core from '@actions/core'
import * as github from '@actions/github'
import { Context } from '@actions/github/lib/context'
import type { GitHub } from '@actions/github/lib/utils'
import { promises as fs } from 'fs'
import ignore from 'ignore'

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
      return core.setFailed(`Required input "token" not provided`)
    }
    if (!file) {
      return core.setFailed(`Required input "file" not provided`)
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

    const changedFiles = await getChangedFiles(octokit, context)
    const reviewers = await parseFileData(data, changedFiles, octokit)
    const filteredReviewers = await filterReviewers(reviewers, octokit, context)

    if (filteredReviewers.length === 0) {
      core.info('No reviewers found')
      return
    }

    await octokit.rest.pulls.requestReviewers({
      owner: context?.repo?.owner,
      repo: context?.repo?.repo,
      pull_number: Number(context?.payload?.pull_request?.number),
      reviewers: filteredReviewers
    })

    core.setOutput(
      'The following reviewers have been requested',
      filteredReviewers.join(', ')
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

  core.info('=== Starting parseFileData ===')
  core.info(`Changed files: ${JSON.stringify(changedFiles)}`)

  for (const file of changedFiles) {
    core.info(`\nProcessing file: ${file}`)
    
    for (const line of data.split('\n')) {
      core.info(`\n--- Processing line: "${line}"`)
      let finalReviewers: string[] | undefined

      if (line.startsWith('#') || line.trim() === '') {
        core.info(`Skipping comment or empty line: "${line}"`)
        continue
      }

      const parsedLined = line.replace(/\s+/g, ' ').split(' ')
      core.info(`Parsed line parts: ${JSON.stringify(parsedLined)}`)
      
      if (parsedLined.length < 2) {
        core.info(`Skipping incorrect line: "${line}" (parts: ${parsedLined.length})`)
        continue
      }

      const ig = ignore().add(parsedLined[0])
      core.info(`Checking if ${file} matches pattern "${parsedLined[0]}"`)
      if (ig.ignores(file)) {
        core.info(`✓ File "${file}" matches pattern "${parsedLined[0]}"`)
        
        for (const reviewer of parsedLined.slice(1)) {
          core.info(`Processing reviewer: "${reviewer}"`)
          if (!reviewer.startsWith('@')) {
            core.info(`Skipping invalid reviewer: "${reviewer}" (doesn't start with @)`)
            continue
          }

          const reviewerName = reviewer.substring(1)
          if (reviewerName.includes('/')) {
            core.info(`Getting members for team: ${reviewerName}`)
            const groupsSplitted = reviewerName.split('/')
            try {
              const { data: members } = await octokit.rest.teams.listMembersInOrg(
                {
                  org: groupsSplitted[0],
                  team_slug: groupsSplitted[1]
                }
              )
              finalReviewers = members.map(member => member.login)
              core.info(`Found team members (${members.length}): ${JSON.stringify(finalReviewers)}`)
            } catch (error) {
              core.error(`Failed to get team members: ${error instanceof Error ? error.message : String(error)}`)
              if (error instanceof Error && 'status' in error) {
                core.error(`Status: ${(error as any).status}`)
                core.error(`Response: ${JSON.stringify((error as any).response?.data)}`)
              }
            }
          } else {
            finalReviewers = [reviewerName]
            core.info(`Added individual reviewer: ${reviewerName}`)
          }
        }
      } else {
        core.info(`✗ File "${file}" does NOT match pattern "${parsedLined[0]}"`)
      }
      
      if (finalReviewers) {
        core.info(`>>> BEFORE Adding reviewers. Current list: ${JSON.stringify(reviewers)}`)
        core.info(`>>> Adding reviewers: ${JSON.stringify(finalReviewers)}`)
        reviewers.push(...finalReviewers)
        core.info(`>>> AFTER Adding reviewers. New list: ${JSON.stringify(reviewers)}`)
      } else {
        core.info('No finalReviewers set for this iteration')
      }
    }
  }

  core.info('=== Finished parseFileData ===')
  core.info(`Final reviewers list (${reviewers.length}): ${JSON.stringify(reviewers)}`)
  return reviewers
}

async function filterReviewers(
  reviewers: string[],
  octokit: InstanceType<typeof GitHub>,
  context: Context
): Promise<string[]> {
  if (
    !context?.payload?.pull_request?.number ||
    !context?.repo?.owner ||
    !context?.repo?.repo
  ) {
    throw new Error('Invalid context')
  }

  const { data: pull } = await octokit.rest.pulls.get({
    owner: context?.repo?.owner,
    repo: context?.repo?.repo,
    pull_number: context?.payload?.pull_request?.number
  })

  return reviewers.filter(
    (reviewer, index) =>
      reviewers.indexOf(reviewer) === index && reviewer !== pull.user.login
  )
}

async function getChangedFiles(
  octokit: InstanceType<typeof GitHub>,
  context: Context
): Promise<string[]> {
  if (
    !context?.payload?.pull_request?.number ||
    !context?.repo?.owner ||
    !context?.repo?.repo
  ) {
    throw new Error('Invalid context')
  }

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: context?.repo?.owner,
    repo: context?.repo?.repo,
    pull_number: context?.payload?.pull_request?.number
  })

  return files.map(file => file.filename)
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
