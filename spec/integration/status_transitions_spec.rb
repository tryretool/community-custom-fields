# frozen_string_literal: true

RSpec.describe "Support-ticket status transitions" do
  before { enable_current_plugin }

  fab!(:admin)
  fab!(:customer) { Fabricate(:user) }
  fab!(:category)

  def create_ticket(user)
    PostCreator.create!(
      user,
      title: "A support ticket title for the spec",
      raw: "Initial ticket body, comfortably long enough.",
      category: category.id,
      skip_validations: true,
    ).topic
  end

  def reply!(user, topic, type: Post.types[:regular])
    PostCreator.create!(
      user,
      topic_id: topic.id,
      raw: "A reply body, comfortably long enough.",
      post_type: type,
      skip_validations: true,
    )
  end

  def set_status!(topic, status, extra = {})
    { status: status }.merge(extra).each { |k, v| topic.custom_fields[k] = v }
    topic.save_custom_fields
  end

  def rows(topic)
    CommunityCustomFields::TopicStatusChange.where(topic_id: topic.id).order(:id)
  end

  describe "topic_created" do
    it "seeds status=new for an admin-created topic and records no row" do
      topic = create_ticket(admin)

      expect(topic.reload.custom_fields["status"]).to eq("new")
      expect(rows(topic)).to be_empty
    end

    it "sets waiting_* when a non-admin creates the topic" do
      topic = create_ticket(customer)

      expect(topic.reload.custom_fields["status"]).to eq("new")
      expect(topic.custom_fields["waiting_id"].to_i).to eq(customer.id)
      expect(topic.custom_fields["waiting_since"]).to be_present
    end
  end

  describe "customer reply (non-admin)" do
    it "reopens a snoozed topic to open and records a post_creation row" do
      topic = create_ticket(admin)
      set_status!(topic, "snoozed", assignee_id: customer.id)

      post = reply!(customer, topic)

      expect(topic.reload.custom_fields["status"]).to eq("open")
      expect(rows(topic).last).to have_attributes(
        from_status: "snoozed",
        to_status: "open",
        source: "post_creation",
        post_id: post.id,
        user_id: nil,
        assignee_id: customer.id,
      )
    end

    it "reopens a recently-closed assigned topic to open and reassigns" do
      topic = create_ticket(admin)
      set_status!(
        topic,
        "closed",
        last_assigned_to_id: customer.id,
        closed_at: Time.current.iso8601,
      )

      reply!(customer, topic)

      topic.reload
      expect(topic.custom_fields["status"]).to eq("open")
      expect(topic.custom_fields["assignee_id"].to_i).to eq(customer.id)
      expect(rows(topic).last.to_status).to eq("open")
    end

    it "reopens a closed topic with no last assignee to new" do
      topic = create_ticket(admin)
      set_status!(topic, "closed", closed_at: Time.current.iso8601)

      reply!(customer, topic)

      expect(topic.reload.custom_fields["status"]).to eq("new")
      expect(rows(topic).last.to_status).to eq("new")
    end

    it "reopens a >1-month-closed topic to new despite a last assignee" do
      topic = create_ticket(admin)
      set_status!(
        topic,
        "closed",
        last_assigned_to_id: customer.id,
        closed_at: 2.months.ago.iso8601,
      )

      reply!(customer, topic)

      expect(topic.reload.custom_fields["status"]).to eq("new")
    end

    it "sets waiting_* and records no row when the status does not change" do
      topic = create_ticket(admin)
      set_status!(topic, "open")

      reply!(customer, topic)

      topic.reload
      expect(topic.custom_fields["status"]).to eq("open")
      expect(topic.custom_fields["waiting_id"].to_i).to eq(customer.id)
      expect(rows(topic)).to be_empty
    end
  end

  describe "admin whisper (post_type 4)" do
    before { SiteSetting.whispers_allowed_groups = Group::AUTO_GROUPS[:staff].to_s }

    it "reopens a snoozed topic to open" do
      topic = create_ticket(admin)
      set_status!(topic, "snoozed")

      reply!(admin, topic, type: Post.types[:whisper])

      expect(topic.reload.custom_fields["status"]).to eq("open")
      expect(rows(topic).last).to have_attributes(
        from_status: "snoozed",
        to_status: "open",
        source: "post_creation",
      )
    end

    it "reopens a closed assigned topic to open" do
      topic = create_ticket(admin)
      set_status!(topic, "closed", last_assigned_to_id: customer.id)

      reply!(admin, topic, type: Post.types[:whisper])

      expect(topic.reload.custom_fields["status"]).to eq("open")
    end

    it "reopens a closed topic with no last assignee to new" do
      topic = create_ticket(admin)
      set_status!(topic, "closed")

      reply!(admin, topic, type: Post.types[:whisper])

      expect(topic.reload.custom_fields["status"]).to eq("new")
    end
  end

  describe "admin regular reply (post_type 1)" do
    it "clears waiting_* and records no row" do
      topic = create_ticket(admin)
      set_status!(topic, "open", waiting_since: 1.hour.ago.iso8601, waiting_id: customer.id)

      reply!(admin, topic)

      topic.reload
      expect(topic.custom_fields["status"]).to eq("open")
      expect(topic.custom_fields["waiting_id"]).to be_blank
      expect(rows(topic)).to be_empty
    end
  end
end
