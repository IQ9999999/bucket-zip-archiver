STACK_NAME   ?= s3-zip-archiver
AWS_REGION   ?= ap-southeast-1
FUNCTION_DIR := src/archiver

# Override to use alternative installs, e.g. SAM="uvx --from aws-sam-cli sam"
SAM      ?= sam
CFN_LINT ?= cfn-lint

.DEFAULT_GOAL := help
.PHONY: help install lint test validate build deploy rollback delete clean

help: ## List available targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

install: ## Install function dependencies
	cd $(FUNCTION_DIR) && npm ci

lint: ## Lint the function code and the CloudFormation template
	cd $(FUNCTION_DIR) && npm run lint
	$(CFN_LINT) template.yaml

test: ## Run unit tests
	cd $(FUNCTION_DIR) && npm test

validate: ## Validate the SAM template
	$(SAM) validate --lint --region $(AWS_REGION)

build: ## Build the Lambda container image
	$(SAM) build

deploy: build ## Build and deploy the stack (publishes a new Lambda version)
	$(SAM) deploy --stack-name $(STACK_NAME) --region $(AWS_REGION)

rollback: ## Move the live alias back: make rollback [VERSION=previous|<n>]
	STACK_NAME=$(STACK_NAME) AWS_REGION=$(AWS_REGION) scripts/rollback.sh $(VERSION)

delete: ## Delete the stack (empty the bucket first)
	$(SAM) delete --stack-name $(STACK_NAME) --region $(AWS_REGION)

clean: ## Remove build output
	rm -rf .aws-sam
