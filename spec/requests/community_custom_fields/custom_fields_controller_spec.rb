# frozen_string_literal: true

RSpec.describe "CommunityCustomFields::CustomFieldsController", type: :request do
  before { enable_current_plugin }

  fab!(:admin)
  fab!(:assignee) { Fabricate(:user) }
  fab!(:topic)

  STATUSES = %w[new open snoozed closed]

  def set_status(topic, status, extra = {})
    { status: status }.merge(extra).each { |k, v| topic.custom_fields[k] = v }
    topic.save_custom_fields
  end

  def put_fields(topic, fields)
    put "/admin/plugins/community-custom-fields/#{topic.id}.json", params: { custom_field: fields }
  end

  def rows(topic)
    CommunityCustomFields::TopicStatusChange.where(topic_id: topic.id).order(:id)
  end

  context "as an admin" do
    before { sign_in(admin) }

    STATUSES.each do |from|
      STATUSES.each do |to|
        next if from == to

        it "records an api_update row for #{from} -> #{to}" do
          set_status(topic, from)
          put_fields(topic, status: to)

          expect(response.status).to eq(200)
          expect(topic.reload.custom_fields["status"]).to eq(to)
          expect(rows(topic).count).to eq(1)
          expect(rows(topic).last).to have_attributes(
            from_status: from,
            to_status: to,
            source: "api_update",
            user_id: admin.id,
            post_id: nil,
          )
          expect(rows(topic).last.duration).to be >= 0
        end
      end
    end

    it "records a from_status=null row when the topic had no prior status" do
      expect(topic.custom_fields["status"]).to be_nil

      put_fields(topic, status: "open")

      expect(response.status).to eq(200)
      expect(rows(topic).count).to eq(1)
      expect(rows(topic).last).to have_attributes(from_status: nil, to_status: "open")
      expect(rows(topic).last.duration).to be >= 0
    end

    it "rejects an invalid status with 422 and records nothing" do
      set_status(topic, "open")

      put_fields(topic, status: "bogus")

      expect(response.status).to eq(422)
      expect(topic.reload.custom_fields["status"]).to eq("open")
      expect(rows(topic)).to be_empty
    end

    it "records no row when the status does not change" do
      set_status(topic, "open")

      put_fields(topic, priority: "high")

      expect(response.status).to eq(200)
      expect(rows(topic)).to be_empty
    end

    it "attributes the row to the assignee before the change" do
      set_status(topic, "open", assignee_id: assignee.id)

      put_fields(topic, status: "closed", assignee_id: "")

      expect(response.status).to eq(200)
      expect(rows(topic).last).to have_attributes(to_status: "closed", assignee_id: assignee.id)
    end

    it "measures duration from the previous recorded change" do
      freeze_time
      set_status(topic, "open")
      CommunityCustomFields::TopicStatusChange.create!(
        topic_id: topic.id,
        from_status: "new",
        to_status: "open",
        source: "api_update",
        duration: 0,
        created_at: 1.hour.ago,
      )

      put_fields(topic, status: "closed")

      expect(response.status).to eq(200)
      expect(rows(topic).last.duration).to eq(1.hour.to_i)
    end
  end

  it "forbids non-admins and records nothing" do
    sign_in(Fabricate(:user))

    put_fields(topic, status: "open")

    expect(response.status).to eq(403)
    expect(rows(topic)).to be_empty
  end
end
