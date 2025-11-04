# GitHub Repository Setup for TAS

## Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Repository name: `tas`
3. Description: "Universal Anti-Spam REST API - Multi-layer spam detection service"
4. Visibility: Public (for GitHub Pages)
5. Initialize with README: No
6. Click "Create repository"

## Step 2: Push Code

```bash
cd tas
git init
git add .
git commit -m "Initial commit: Universal Anti-Spam API"
git branch -M main
git remote add origin https://github.com/kiku-jw/tas.git
git push -u origin main
```

## Step 3: Enable GitHub Pages

1. Go to repository Settings → Pages
2. Source: Deploy from a branch
3. Branch: `main` → `/docs` folder
4. Click Save

## Step 4: Update API URL in Demo

After deployment, update `docs/index.html`:
- Change `API_URL` to your production API URL
- Or use environment variable for dynamic URL

## Step 5: RapidAPI Preparation

1. Create RapidAPI provider account
2. Prepare API documentation
3. Test endpoints
4. Submit for review

## Repository Structure

```
tas/
├── app/              # Application code
├── tests/            # Test suite
├── docs/             # GitHub Pages demo
├── .github/           # GitHub Actions
├── README.md          # Main documentation
└── pyproject.toml     # Dependencies
```

