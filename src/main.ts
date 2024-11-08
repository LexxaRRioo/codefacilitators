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
    console.log('=== Starting action ===')
    const context: Context = github?.context
    const githubToken: string = core.getInput('token')
    const file: string = core.getInput('file')

    console.log('Input file path:', file)

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
    console.log('File content:', data)

    const changedFiles = await getChangedFiles(octokit, context)
    console.log('Changed files:', changedFiles)
    
    const reviewers = await parseFileData(data, changedFiles, octokit)
    console.log('Parsed reviewers:', reviewers)
    
    const filteredReviewers = await filterReviewers(reviewers, octokit, context)
    console.log('Filtered reviewers:', filteredReviewers)

    if (filteredReviewers.length === 0) {
      console.log('No reviewers found after filtering')
      return
    }

    console.log('Requesting reviewers:', filteredReviewers)
    await octokit.rest.pulls.requestReviewers({
      owner: context?.repo?.owner,
      repo: context?.repo?.repo,
      pull_number: Number(context?.payload?.pull_request?.number),
      reviewers: filteredReviewers
    })
    console.log('Successfully requested reviewers')

} catch (error) {
    console.error('Action failed with error:', error)
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function parseFileData(
  data: string,
  changedFiles: string[],
  octokit: InstanceType<typeof GitHub>
): Promise<string[]> {
  const reviewers: string[] = []

  console.log('=== Starting parseFileData ===')
  console.log('Changed files:', changedFiles)

  for (const file of changedFiles) {
    console.log('\nProcessing file:', file)
    
    for (const line of data.split('\n')) {
      console.log('\n--- Processing line:', line)
      let finalReviewers: string[] | undefined

      if (line.startsWith('#') || line.trim() === '') {
        console.log('Skipping comment or empty line:', line)
        continue
      }

      const parsedLined = line.replace(/\s+/g, ' ').split(' ')
      console.log('Parsed line parts:', parsedLined)
      
      if (parsedLined.length < 2) {
        console.log('Skipping incorrect line:', line, '(parts:', parsedLined.length, ')')
        continue
      }

      const ig = ignore().add(parsedLined[0])
      console.log('Checking if', file, 'matches pattern', parsedLined[0])
      if (ig.ignores(file)) {
        console.log('✓ File', file, 'matches pattern', parsedLined[0])
        
        for (const reviewer of parsedLined.slice(1)) {
          console.log('Processing reviewer:', reviewer)
          if (!reviewer.startsWith('@')) {
            console.log('Skipping invalid reviewer:', reviewer, '(doesn\'t start with @)')
            continue
          }

          const reviewerName = reviewer.substring(1)
          console.log('Reviewer name after @ removal:', reviewerName)
          
          if (reviewerName.includes('/')) {
            console.log('Getting members for team:', reviewerName)
            const groupsSplitted = reviewerName.split('/')
            try {
              const { data: members } = await octokit.rest.teams.listMembersInOrg(
                {
                  org: groupsSplitted[0],
                  team_slug: groupsSplitted[1]
                }
              )
              finalReviewers = members.map(member => member.login)
              console.log('Found team members:', finalReviewers)
            } catch (error) {
              console.error('Failed to get team members:', error)
              if (error instanceof Error && 'status' in error) {
                console.error('Status:', (error as any).status)
                console.error('Response:', (error as any).response?.data)
              }
            }
          } else {
            finalReviewers = [reviewerName]
            console.log('Added individual reviewer:', reviewerName)
          }
        }
      } else {
        console.log('✗ File', file, 'does NOT match pattern', parsedLined[0])
      }
      
      if (finalReviewers) {
        console.log('>>> BEFORE Adding reviewers. Current list:', reviewers)
        console.log('>>> Adding reviewers:', finalReviewers)
        reviewers.push(...finalReviewers)
        console.log('>>> AFTER Adding reviewers. New list:', reviewers)
      } else {
        console.log('No finalReviewers set for this iteration')
      }
    }
  }

  console.log('=== Finished parseFileData ===')
  console.log('Final reviewers list:', reviewers)
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
  console.log('=== Starting filterReviewers ===')
  console.log('Input reviewers:', reviewers)

  const { data: pull } = await octokit.rest.pulls.get({
    owner: context?.repo?.owner,
    repo: context?.repo?.repo,
    pull_number: context?.payload?.pull_request?.number
  })
  console.log('PR author:', pull.user.login)

  const filtered = reviewers.filter(
    (reviewer, index) =>
      reviewers.indexOf(reviewer) === index && reviewer !== pull.user.login
  )
  console.log('Filtered reviewers:', filtered)
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
