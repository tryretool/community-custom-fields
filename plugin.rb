# frozen_string_literal: true

# name: darren-test
# about: TODO
# meta_topic_id: TODO
# version: 0.0.1
# authors: Discourse
# url: TODO
# required_version: 2.7.0

enabled_site_setting :darren_test_enabled

module ::DarrenTest
  PLUGIN_NAME = "darren-test"
end

require_relative "lib/darren_test/engine"

after_initialize do
  # Code which should run after Rails has finished booting
end
