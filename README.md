# CODEFACILITATORS

GitHub Action to assign PR reviewers based on CODEFACAILITATORS file in the repository.

This action replicated CODEOWNERS functionality but by only assigning reviewers to PR's.

#### 📋 GitHub Action Inputs

**file** - the name of the file to read CODEFACILITATORS from (defaults to ./github/CODEFACILITATORS if not provided)

```
file: ./github/CODEFACILITATORS
```

**token** - the GitHub token to use for authentication

```
token: ${{ secrets.GITHUB_TOKEN }}
```


#### 📋 Example YAML file configuration

```yaml
name: "Assign Code Facilitators to PRs"

on:  
  pull_request:
    types: [opened]

jobs:
  assign-code-facilitators:
    runs-on: ubuntu-latest
    steps:
    - name: "Assign Code Facilitators to PR"
      uses: 0xtekgrinder/codefacilitator@v1
      with:
        token: ${{ secrets.GITHUB_TOKEN }}
        file: ./github/CODEFACILITATORS
```

