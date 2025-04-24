# frozen_string_literal: true

DarrenTest::Engine.routes.draw do
  get "/examples" => "examples#index"
  # define routes here
end

Discourse::Application.routes.draw { mount ::DarrenTest::Engine, at: "darren-test" }
