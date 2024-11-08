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
    const addGroupsDirectly: boolean = core.getInput('add_groups_directly') === 'true'

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

    const changedFiles = await getChangedFiles(octokit, context)
    core.info(`Changed files: ${changedFiles}`)

    const reviewers = await parseFileData(data, changedFiles, octokit, addGroupsDirectly)
    core.info(`Parsed reviewers: ${reviewers}`)

    const filteredReviewers = await filterReviewers(reviewers, octokit, context)
    core.info(`Filtered reviewers: ${filteredReviewers}`)

    if (filteredReviewers.length === 0) {
      core.info('No reviewers found after filtering')
      return
    }

    const { reviewersList, teamReviewersList } = separateReviewers(filteredReviewers)

    core.info(`Requesting reviewers: ${reviewersList}`)
    core.info(`Requesting team reviewers: ${teamReviewersList}`)

    await octokit.rest.pulls.requestReviewers({
      owner: context?.repo?.owner,
      repo: context?.repo?.repo,
      pull_number: Number(context?.payload?.pull_request?.number),
      reviewers: reviewersList,
      team_reviewers: teamReviewersList
    })
    core.info('Successfully requested reviewers')

  } catch (error) {
    console.error('Action failed with error:', error)
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function parseFileData(
  data: string,
  changedFiles: string[],
  octokit: InstanceType<typeof GitHub>,
  addGroupsDirectly: boolean
): Promise<string[]> {
  const reviewers: string[] = []

  core.info('=== Starting parse File Data ===')
  core.info(`Changed files: ${changedFiles}`)
  core.info(`Add groups directly mode: ${addGroupsDirectly}`)

  for (const file of changedFiles) {
    core.info(`\nProcessing file: ${file}`)

    for (const line of data.split('\n')) {
      let finalReviewers: string[] | undefined

      if (line.startsWith('#') || line.trim() === '') {
        core.info(`Skipping comment or empty line: ${line}`)
        continue
      }

      const parsedLined = line.replace(/\s+/g, ' ').split(' ')

      if (parsedLined.length < 2) {
        core.info(`Skipping incorrect line: ${line} (parts: ${parsedLined.length})`)
        continue
      }

      const ig = ignore().add(parsedLined[0])
      if (ig.ignores(file)) {
        core.info(`✓ File ${file} matches pattern ${parsedLined[0]}`)

        for (const reviewer of parsedLined.slice(1)) {
          core.info(`Processing reviewer: ${reviewer}`)
          if (!reviewer.startsWith('@')) {
            core.info(`Skipping invalid reviewer: ${reviewer} (doesn't start with @)`)
            continue
          }

          const reviewerName = reviewer.substring(1)

          if (reviewerName.includes('/')) {
            if (addGroupsDirectly) {
              // Add the team directly as a reviewer
              finalReviewers = [reviewerName]
              core.info(`Added team directly: ${reviewerName}`)
            } else {
              // Original behavior: fetch team members
              const groupsSplitted = reviewerName.split('/')
              try {
                const { data: members } = await octokit.rest.teams.listMembersInOrg(
                  {
                    org: groupsSplitted[0],
                    team_slug: groupsSplitted[1]
                  }
                )
                finalReviewers = members.map(member => member.login)
                core.info(`Found team members: ${finalReviewers}`)
              } catch (error) {
                console.error('Failed to get team members:', error)
                if (error instanceof Error && 'status' in error) {
                  console.error('Status:', (error as any).status)
                  console.error('Response:', (error as any).response?.data)
                }
              }
            }
          } else {
            finalReviewers = [reviewerName]
            core.info(`Added individual reviewer: ${reviewerName}`)
          }
        }
      } else {
        core.info(`✗ File ${file} does NOT match pattern ${parsedLined[0]}`)
      }

      if (finalReviewers) {
        core.info(`Adding reviewers: ${finalReviewers}`)
        reviewers.push(...finalReviewers)
      } else {
        core.info('No finalReviewers set for this iteration')
      }
    }
  }
  core.info('=== Finishing parse File Data ===')
  return reviewers
}

function separateReviewers(reviewers: string[]): { reviewersList: string[], teamReviewersList: string[] } {
  const reviewersList: string[] = []
  const teamReviewersList: string[] = []

  for (const reviewer of reviewers) {
    if (reviewer.includes('/')) {
      teamReviewersList.push(reviewer.split('/')[1]) // Only add the team slug part
    } else {
      reviewersList.push(reviewer)
    }
  }

  return { reviewersList, teamReviewersList }
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
  core.info(`PR author: ${pull.user.login}`)

  const filtered = reviewers.filter(
    (reviewer, index) =>
      reviewers.indexOf(reviewer) === index && reviewer !== pull.user.login
  )
  core.info(`Filtered reviewers without PR author: ${filtered}`)
  return filtered
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