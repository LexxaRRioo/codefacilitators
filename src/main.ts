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

    // Log initial configuration
    core.info('🔄 Starting reviewer assignment process')
    core.info('───────────────────────────────────')
    core.info(`Mode: ${addGroupsDirectly ? 'Direct team assignment' : 'Individual members assignment'}`)

    const changedFiles = await getChangedFiles(octokit, context)
    core.info('\n📁 Changed Files:')
    changedFiles.forEach(file => core.info(`   ${file}`))

    const reviewers = await parseFileData(data, changedFiles, octokit, addGroupsDirectly)
    const filteredReviewers = await filterReviewers(reviewers, octokit, context)

    if (filteredReviewers.length === 0) {
      core.info('\n❌ No eligible reviewers found')
      return
    }

    const { reviewersList, teamReviewersList } = separateReviewers(filteredReviewers)

    core.info('\n📋 Review Assignment Summary:')
    core.info('───────────────────────────────────')
    if (reviewersList.length > 0) {
      core.info(`Individual reviewers: ${reviewersList.join(', ')}`)
    }
    if (teamReviewersList.length > 0) {
      core.info(`Team reviewers: ${teamReviewersList.join(', ')}`)
    }

    await octokit.rest.pulls.requestReviewers({
      owner: context?.repo?.owner,
      repo: context?.repo?.repo,
      pull_number: Number(context?.payload?.pull_request?.number),
      reviewers: reviewersList,
      team_reviewers: teamReviewersList
    })
    core.info('\n✅ Successfully assigned reviewers')

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

  core.info('\n🔍 Analyzing files for reviewer patterns')
  core.info('───────────────────────────────────')

  for (const file of changedFiles) {
    for (const line of data.split('\n')) {
      let finalReviewers: string[] | undefined

      if (line.startsWith('#') || line.trim() === '') {
        continue
      }

      const parsedLined = line.replace(/\s+/g, ' ').split(' ')

      if (parsedLined.length < 2) {
        continue
      }

      const ig = ignore().add(parsedLined[0])
      if (ig.ignores(file)) {
        core.info(`Match: ${file} → ${parsedLined[0]}`)

        for (const reviewer of parsedLined.slice(1)) {
          if (!reviewer.startsWith('@')) {
            continue
          }

          const reviewerName = reviewer.substring(1)

          if (reviewerName.includes('/')) {
            if (addGroupsDirectly) {
              finalReviewers = [reviewerName]
              core.info(`   → Adding team: ${reviewerName}`)
            } else {
              const groupsSplitted = reviewerName.split('/')
              try {
                const { data: members } = await octokit.rest.teams.listMembersInOrg({
                  org: groupsSplitted[0],
                  team_slug: groupsSplitted[1]
                })
                finalReviewers = members.map(member => member.login)
                core.info(`   → Adding team members: ${finalReviewers.join(', ')}`)
              } catch (error) {
                console.error('Failed to get team members:', error)
                if (error instanceof Error && 'status' in error) {
                  console.error('Status:', (error as any).status)
                }
              }
            }
          } else {
            finalReviewers = [reviewerName]
            core.info(`   → Adding reviewer: ${reviewerName}`)
          }
        }
      }

      if (finalReviewers) {
        reviewers.push(...finalReviewers)
      }
    }
  }
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
  if (!context?.payload?.pull_request?.number ||
    !context?.repo?.owner ||
    !context?.repo?.repo) {
    throw new Error('Invalid context')
  }

  const { data: pull } = await octokit.rest.pulls.get({
    owner: context?.repo?.owner,
    repo: context?.repo?.repo,
    pull_number: context?.payload?.pull_request?.number
  })

  const filtered = reviewers.filter(
    (reviewer, index) =>
      reviewers.indexOf(reviewer) === index && reviewer !== pull.user.login
  )
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