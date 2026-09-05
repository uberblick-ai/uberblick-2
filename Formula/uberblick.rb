class Uberblick < Formula
  desc "Local-first collaborative documents for people and agents"
  homepage "https://github.com/uberblick-ai/uberblick-2"
  url "https://api.github.com/repos/uberblick-ai/uberblick-2/releases/assets/546301506",
      header: [
        "Accept: application/octet-stream",
        "Authorization: Bearer #{ENV.fetch("HOMEBREW_GITHUB_API_TOKEN")}",
      ]
  version "0.1.0"
  sha256 "c8ed8f1ed74cc9f2ba80d537694b35719ef1b7ee4bc19671c37dd50d79fe1afe"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    inreplace libexec/"bin/ub", "#!/usr/bin/env node", "#!#{Formula["node"].opt_bin}/node"
    bin.install_symlink libexec/"bin/ub"
    bin.install_symlink libexec/"bin/uberblick"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/ub --version").strip
    assert_equal version.to_s, shell_output("#{bin}/uberblick --version").strip
  end
end
