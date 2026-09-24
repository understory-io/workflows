# Fixtures for semgrep/terraform.yml. `ruleid:` marks the line that must be
# flagged, `ok:` a line that must not be. Run with `semgrep --test semgrep/`.

# --- Floating: must be flagged ---------------------------------------------

# An ECS-optimised AMI feeding a single-instance ASG's launch template.
data "aws_ami" "ecs_optimized" {
  # ruleid: aws-ami-must-be-pinned
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-ecs-hvm-2023.*-x86_64"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

# A plain AL2023 AMI feeding an aws_instance, attributes in a different order.
data "aws_ami" "al2023" {
  owners = ["amazon"]
  # ruleid: aws-ami-must-be-pinned
  most_recent = true

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
}

# A lookup nothing references is still flagged: it is one edit from floating.
data "aws_ami" "ubuntu_lookup" {
  # ruleid: aws-ami-must-be-pinned
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

data "aws_ami" "from_variable" {
  # ruleid: aws-ami-must-be-pinned
  most_recent = var.track_latest_ami
  owners      = ["amazon"]
}

data "aws_ssm_parameter" "ecs_ami" {
  # ruleid: aws-ami-must-be-pinned
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

data "aws_ssm_parameter" "al2023_ami" {
  # ruleid: aws-ami-must-be-pinned
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_launch_template" "resolved_at_launch" {
  name_prefix = "floating-"
  # ruleid: aws-ami-must-be-pinned
  image_id = "resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

resource "aws_imagebuilder_image_recipe" "resolved_ami_id" {
  name = "floating"
  # ruleid: aws-ami-must-be-pinned
  ami_id = "resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# --- Pinned: must not be flagged -------------------------------------------

resource "aws_launch_template" "pinned" {
  name_prefix = "pinned-"
  # ok: aws-ami-must-be-pinned
  image_id      = "ami-0abc1234def567890" # al2023-ami-ecs-hvm-2023.0.20260901, pinned 2026-09-24
  instance_type = "t3.small"
}

resource "aws_instance" "pinned" {
  # ok: aws-ami-must-be-pinned
  ami           = "ami-0abc1234def567890" # al2023-ami-2023.8.20260901, pinned 2026-09-24
  instance_type = "t3.micro"
}

# An exact image id resolves to one AMI forever.
data "aws_ami" "exact_id" {
  # ok: aws-ami-must-be-pinned
  most_recent = false
  owners      = ["amazon"]

  filter {
    name   = "image-id"
    values = ["ami-0abc1234def567890"]
  }
}

# Without most_recent a filter matching two images fails the plan instead of
# silently moving, so it cannot roll anything.
data "aws_ami" "exact_name" {
  owners = ["amazon"]

  filter {
    # ok: aws-ami-must-be-pinned
    name   = "name"
    values = ["al2023-ami-ecs-hvm-2023.0.20260901-kernel-6.1-x86_64"]
  }
}

resource "aws_launch_template" "from_exact_lookup" {
  name_prefix = "exact-"
  # ok: aws-ami-must-be-pinned
  image_id = data.aws_ami.exact_name.id
}

# A parameter the team owns, and a non-AMI public parameter.
data "aws_ssm_parameter" "own_pin" {
  # ok: aws-ami-must-be-pinned
  name = "/my-team/app/ami_id"
}

data "aws_ssm_parameter" "regions" {
  # ok: aws-ami-must-be-pinned
  name = "/aws/service/global-infrastructure/regions"
}

# `most_recent` on other data sources means something else entirely.
data "aws_ebs_snapshot" "latest_backup" {
  # ok: aws-ami-must-be-pinned
  most_recent = true
  owners      = ["self"]
}

# Deliberate floating, suppressed with a reason.
data "aws_ami" "stateless_fleet" {
  # Floats on purpose: 3-instance ASG with instance_refresh and min_healthy_percentage = 66.
  most_recent = true # nosemgrep: aws-ami-must-be-pinned
  owners      = ["amazon"]
}
